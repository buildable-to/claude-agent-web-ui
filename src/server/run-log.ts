// One record per run, for pricing (ezdxf-flask #1227). A run is one stretch
// of work: from the engineer's message (or a turn the engine starts itself)
// until the conversation is quiet again — no turn, no sub-agent, no question
// waiting — or the engine stops. When it ends, the service counts the tokens
// it spent from the engine's own transcripts (the main loop's file, and the
// sub-agents' files apart), prices them, and hands the run to the app's
// door, which adds the project's size and stores it once. Nothing here is
// shown to an engineer.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk';

export type Outcome = 'ok' | 'error' | 'stopped' | 'restart';

/** What the engine reports when a run ends (live-session.ts). */
export type RunEnd = {
  startedAt: number;
  endedAt: number;
  outcome: Outcome;
  error?: string;
  turns?: number;
  /** The engine's running totals per model at the run's last result. */
  modelUsage?: Record<string, ModelUsage>;
};

export type Tokens = { input: number; output: number; cache_read: number; cache_write: number; cache_write_1h: number };
export type Priced = Omit<Tokens, 'cache_write_1h'> & { usd: number | null };
export type Count = { main: Record<string, Tokens>; subagents: Record<string, Tokens>; last: number };

/** The record handed to the app (buildable/services/agent_run_log.py). */
export type RunRecord = {
  run_id: string;
  account: string;
  project: string | null;
  scope: 'project' | 'library' | null;
  conversation: string;
  title?: string;
  first: boolean;
  started_at: number;
  ended_at: number;
  outcome: Outcome;
  error?: string;
  turns?: number;
  models: Record<string, Priced>;
  subagents: Record<string, Priced>;
  /** How often the door refused it (it waits in the folder meanwhile). */
  tries?: number;
};

/** A record the door refuses this many times is dropped (and logged), so
 *  one bad record never blocks the ones after it. */
const MAX_TRIES = 20;

/** A model's price for each kind of token, as a multiple of its input
 *  price: the same for every Claude model. */
const WEIGHT = { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25, cache_write_1h: 2 } as const;

/** The model a usage row is keyed by, without a context tag ("[1m]"). */
export function modelName(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '');
}

function weigh(t: Tokens): number {
  return (
    t.input * WEIGHT.input +
    t.output * WEIGHT.output +
    t.cache_read * WEIGHT.cache_read +
    (t.cache_write - t.cache_write_1h) * WEIGHT.cache_write +
    t.cache_write_1h * WEIGHT.cache_write_1h
  );
}

/** Each model's input price in dollars per token, from the engine's own
 *  running totals. The totals do not say how long a cache write is kept;
 *  the server's are an hour (Claude Code's own choice), so they are weighed
 *  as such. A model with no cost yet says nothing. */
export function ratesFrom(usage: Record<string, ModelUsage>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [model, u] of Object.entries(usage)) {
    const w = weigh({
      input: u.inputTokens,
      output: u.outputTokens,
      cache_read: u.cacheReadInputTokens,
      cache_write: u.cacheCreationInputTokens,
      cache_write_1h: u.cacheCreationInputTokens,
    });
    if (w > 0 && u.costUSD > 0) out[modelName(model)] = u.costUSD / w;
  }
  return out;
}

export function price(rows: Record<string, Tokens>, rates: Record<string, number>): Record<string, Priced> {
  const out: Record<string, Priced> = {};
  for (const [model, t] of Object.entries(rows)) {
    const rate = rates[model];
    const { cache_write_1h: _h, ...tokens } = t;
    out[model] = { ...tokens, usd: rate === undefined ? null : Math.round(weigh(t) * rate * 1e6) / 1e6 };
  }
  return out;
}

const zero = (): Tokens => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 });

type Row = {
  type?: string;
  isSidechain?: boolean;
  timestamp?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: { ephemeral_1h_input_tokens?: number };
    };
  };
};

/** The tokens one conversation spent between `from` and `to` (ms), per
 *  model, the main loop's apart from the sub-agents'. The engine writes one
 *  line per content block, each carrying its API call's usage: a call is
 *  counted once, by its message id, at its largest output. `last` is when the
 *  newest counted call was made (0 when none). */
export function countTokens(transcripts: string, sessionId: string, from: number, to: number): Count {
  const calls = new Map<string, { model: string; sub: boolean; t: Tokens }>();
  let last = 0;
  const read = (file: string, sub: boolean) => {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue;
      let row: Row;
      try {
        row = JSON.parse(line) as Row;
      } catch {
        continue; // a torn last line while the engine writes
      }
      const m = row.message;
      if (row.type !== 'assistant' || !m?.usage || !m.model || m.model === '<synthetic>') continue;
      const at = Date.parse(row.timestamp ?? '');
      if (!(at >= from && at <= to)) continue;
      const u = m.usage;
      const t: Tokens = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cache_read: u.cache_read_input_tokens ?? 0,
        cache_write: u.cache_creation_input_tokens ?? 0,
        cache_write_1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      };
      const key = m.id ?? `${file}:${row.timestamp}`;
      const seen = calls.get(key);
      if (!seen || t.output >= seen.t.output) calls.set(key, { model: modelName(m.model), sub: sub || row.isSidechain === true, t });
      last = Math.max(last, at);
    }
  };
  read(join(transcripts, `${sessionId}.jsonl`), false);
  const subDir = join(transcripts, sessionId, 'subagents');
  let files: string[] = [];
  try {
    files = readdirSync(subDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    // no sub-agents in this conversation
  }
  for (const f of files) read(join(subDir, f), true);
  const out: Count = { main: {}, subagents: {}, last };
  for (const { model, sub, t } of calls.values()) {
    const side = sub ? out.subagents : out.main;
    const sum = (side[model] ??= zero());
    for (const k of Object.keys(sum) as (keyof Tokens)[]) sum[k] += t[k];
  }
  return out;
}

/** Hands a record to the app's door; true when it was stored. */
export type Sender = (record: RunRecord) => Promise<boolean>;

/** The door: `python -m buildable.services.agent_run_log`, the record on its
 *  stdin, in the engines' environment (the app's checkout, its Python, the
 *  database it reaches) and never the service's secrets. */
export function doorSender(env: Record<string, string>, timeoutMs = 120_000): Sender {
  return (record) =>
    new Promise((resolve) => {
      const child = spawn(process.env.BUILDABLE_PYTHON || 'python3', ['-m', 'buildable.services.agent_run_log'], {
        env,
        ...(env.BUILDABLE_REPO ? { cwd: env.BUILDABLE_REPO } : {}),
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString();
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        console.error(`[runs] could not start the door: ${String(e)}`);
        resolve(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) console.error(`[runs] ${record.run_id} not recorded (${code}): ${err.trim().slice(-300)}`);
        resolve(code === 0);
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(JSON.stringify(record));
    });
}

const OPEN_FILE = '.agent-runs-open.json';
const UNSENT_FILE = '.agent-runs-unsent.jsonl';
const RATES_FILE = '.agent-rates.json';

type Open = { runId: string; startedAt: number };
export type Conversation = { project: string | null; scope: 'project' | 'library' | null; title?: string; first: boolean };

/** One account folder's runs. Records that could not be stored wait in the
 *  folder and go first with the next one; a run the service died in is
 *  recorded as cut by a restart when the service comes back. */
export class RunLog {
  private rates: Record<string, number>;
  private open: Record<string, Open>;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly folder: string,
    private readonly account: string,
    /** Where the engine keeps this folder's conversations. */
    private readonly transcripts: string,
    private readonly send: Sender,
    /** What the manager knows of a conversation. */
    private readonly about: (sessionId: string) => Conversation,
  ) {
    this.rates = this.readJson<Record<string, number>>(RATES_FILE);
    this.open = this.readJson<Record<string, Open>>(OPEN_FILE);
    const left = Object.entries(this.open);
    this.open = {};
    if (left.length) this.writeJson(OPEN_FILE, this.open);
    for (const [sessionId, o] of left) {
      // its last call is the last thing it is known to have done
      const end = Math.max(o.startedAt, countTokens(this.transcripts, sessionId, o.startedAt, Date.now()).last);
      this.finish(sessionId, o, { startedAt: o.startedAt, endedAt: end, outcome: 'restart', error: 'the agent service stopped during the run' });
    }
  }

  /** A run began: remembered on disk until it ends. */
  begin(sessionId: string, startedAt: number) {
    this.open = { ...this.open, [sessionId]: { runId: randomUUID(), startedAt } };
    this.writeJson(OPEN_FILE, this.open);
  }

  end(sessionId: string, run: RunEnd) {
    const o = this.open[sessionId] ?? { runId: randomUUID(), startedAt: run.startedAt };
    const { [sessionId]: _done, ...rest } = this.open;
    this.open = rest;
    this.writeJson(OPEN_FILE, this.open);
    this.finish(sessionId, o, run);
  }

  /** Every record still waiting has been tried (tests). */
  settled(): Promise<void> {
    return this.chain;
  }

  private finish(sessionId: string, o: Open, run: RunEnd) {
    if (run.modelUsage) {
      this.rates = { ...this.rates, ...ratesFrom(run.modelUsage) };
      this.writeJson(RATES_FILE, this.rates);
    }
    // the engine's own lines land a moment after its message; a second's grace
    const count = countTokens(this.transcripts, sessionId, run.startedAt - 1000, run.endedAt + 1000);
    const c = this.about(sessionId);
    const record: RunRecord = {
      run_id: o.runId,
      account: this.account,
      project: c.project,
      scope: c.scope,
      conversation: sessionId,
      ...(c.title ? { title: c.title } : {}),
      first: c.first,
      started_at: run.startedAt,
      ended_at: run.endedAt,
      outcome: run.outcome,
      ...(run.error ? { error: run.error.slice(0, 500) } : {}),
      ...(run.turns !== undefined ? { turns: run.turns } : {}),
      models: price(count.main, this.rates),
      subagents: price(count.subagents, this.rates),
    };
    this.chain = this.chain.then(() => this.deliver(record)).catch((err: unknown) => {
      console.error(`[runs] ${String(err)}`);
    });
  }

  /** Send what waits, then this one; keep whatever was not stored. */
  private async deliver(record: RunRecord) {
    const path = join(this.folder, UNSENT_FILE);
    const waiting: RunRecord[] = [];
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          waiting.push(JSON.parse(line) as RunRecord);
        } catch {
          // a torn line: nothing to send
        }
      }
    }
    const keep: RunRecord[] = [];
    for (const r of [...waiting, record]) {
      // once one fails the database is likely away: keep the rest for next time
      if (!keep.length && (await this.send(r))) continue;
      const tries = (r.tries ?? 0) + (keep.length ? 0 : 1);
      if (tries >= MAX_TRIES) console.error(`[runs] dropped ${r.run_id} after ${tries} tries: ${JSON.stringify(r).slice(0, 300)}`);
      else keep.push({ ...r, tries });
    }
    if (!keep.length) {
      if (waiting.length) rmSync(path, { force: true });
      return;
    }
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  }

  private readJson<T extends object>(name: string): T {
    try {
      return JSON.parse(readFileSync(join(this.folder, name), 'utf8')) as T;
    } catch {
      return {} as T;
    }
  }

  private writeJson(name: string, value: object) {
    const path = join(this.folder, name);
    try {
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(value) + '\n');
      renameSync(tmp, path);
    } catch (err) {
      console.error(`[runs] could not write ${name}: ${String(err)}`);
    }
  }
}
