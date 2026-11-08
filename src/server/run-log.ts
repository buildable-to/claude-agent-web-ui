// One record per run, for pricing (ezdxf-flask #1227). A run is one stretch
// of work: from the engineer's message (or a turn the engine starts itself)
// until the conversation is quiet again — no turn, no sub-agent, no question
// waiting — or the engine stops. When it ends, the run is written to the
// account's folder at once; then the service counts the tokens it spent from
// the engine's own transcripts (the main loop's file, and the sub-agents'
// files apart), prices them, and hands the run to the app's door, which adds
// the project's size and stores it once. Nothing here is shown to an
// engineer.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
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
export type Count = {
  main: Record<string, Tokens>;
  subagents: Record<string, Tokens>;
  seen: Record<string, Tokens>;
  earlier: boolean;
  last: number;
};

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
 *  running totals (its cost over its tokens: what it charged for calls the
 *  transcripts do not show, a web fetch's summary or a compaction, is spread
 *  over the rest). The totals do not say how long a cache write is kept —
 *  an hour costs more than five minutes — so the share of hour-long writes
 *  is read from the conversation's transcripts (`seen`): the main loop
 *  writes for an hour, sub-agents for five minutes. A model with no cost
 *  yet says nothing. */
export function ratesFrom(usage: Record<string, ModelUsage>, seen: Record<string, Tokens> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, u] of Object.entries(usage)) {
    const model = modelName(u.canonicalModel ?? key);
    const s = seen[model];
    const hour = s && s.cache_write > 0 ? s.cache_write_1h / s.cache_write : 1;
    const w = weigh({
      input: u.inputTokens,
      output: u.outputTokens,
      cache_read: u.cacheReadInputTokens,
      cache_write: u.cacheCreationInputTokens,
      cache_write_1h: u.cacheCreationInputTokens * hour,
    });
    if (w > 0 && u.costUSD > 0) out[model] = u.costUSD / w;
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

/** The tokens one conversation spent from `from` until `to` (ms), per
 *  model, the main loop's apart from the sub-agents'. The engine writes one
 *  line per content block, each carrying its API call's usage: a call is
 *  counted once, by its message id, at its largest output. `seen` is every
 *  call up to `to`, main and sub-agents together; `earlier` whether the
 *  main loop made a call before `from` (the conversation had a run before);
 *  `last` when the newest call in the window was made (0 when none). */
export async function countTokens(transcripts: string, sessionId: string, from: number, to: number): Promise<Count> {
  const calls = new Map<string, { model: string; sub: boolean; at: number; t: Tokens }>();
  const read = async (file: string, sub: boolean) => {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
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
      if (!(at <= to)) continue;
      const u = m.usage;
      const t: Tokens = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cache_read: u.cache_read_input_tokens ?? 0,
        cache_write: u.cache_creation_input_tokens ?? 0,
        cache_write_1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      };
      const key = m.id ?? `${file}:${row.timestamp}`;
      const had = calls.get(key);
      if (!had || t.output >= had.t.output) {
        calls.set(key, { model: modelName(m.model), sub: sub || row.isSidechain === true, at: had ? Math.min(had.at, at) : at, t });
      }
    }
  };
  await read(join(transcripts, `${sessionId}.jsonl`), false);
  const subDir = join(transcripts, sessionId, 'subagents');
  let files: string[] = [];
  try {
    files = (await readdir(subDir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    // no sub-agents in this conversation
  }
  for (const f of files) await read(join(subDir, f), true);
  const out: Count = { main: {}, subagents: {}, seen: {}, earlier: false, last: 0 };
  const add = (side: Record<string, Tokens>, model: string, t: Tokens) => {
    const sum = (side[model] ??= zero());
    for (const k of Object.keys(sum) as (keyof Tokens)[]) sum[k] += t[k];
  };
  for (const { model, sub, at, t } of calls.values()) {
    add(out.seen, model, t);
    if (at < from) {
      if (!sub) out.earlier = true;
      continue;
    }
    add(sub ? out.subagents : out.main, model, t);
    out.last = Math.max(out.last, at);
  }
  return out;
}

/** What the door said: stored, refused, or not there yet (the app's
 *  checkout on this server is older than this service: wait for it). */
export type Sent = true | false | 'later';

/** Hands a record to the app's door. */
export type Sender = (record: RunRecord) => Promise<Sent>;

const DOOR = 'buildable.services.agent_run_log';

/** The door: `python -m buildable.services.agent_run_log`, the record on its
 *  stdin, in the engines' environment (the app's checkout, its Python, the
 *  database it reaches) and never the service's secrets. */
export function doorSender(env: Record<string, string>, timeoutMs = 120_000): Sender {
  return (record) =>
    new Promise((resolve) => {
      const repo = env.BUILDABLE_REPO;
      if (repo && !existsSync(join(repo, ...DOOR.split('.')) + '.py')) {
        resolve('later');
        return;
      }
      const child = spawn(process.env.BUILDABLE_PYTHON || 'python3', ['-m', DOOR], {
        env,
        ...(repo ? { cwd: repo } : {}),
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
/** The rates learned last, for a run that ended with no result to learn from. */
const RATES_FILE = '.agent-rates.json';

type Open = { runId: string; startedAt: number };
export type Conversation = { project: string | null; scope: 'project' | 'library' | null; title?: string; first: boolean };

/** A run that ended, as it waits in the folder until the door has it: what
 *  the service knew when it ended. Its tokens are counted when it is sent —
 *  the transcripts keep them — so a run ended by a deploy is not lost with
 *  the process. */
type Ended = Omit<RunRecord, 'models' | 'subagents'> & { modelUsage?: Record<string, ModelUsage> };

/** One account folder's runs. Every run is written to the folder as it
 *  ends and leaves it once the door has stored it; a run the service died in
 *  is recorded as cut by a restart when the service comes back. */
export class RunLog {
  private rates: Record<string, number> = {};
  private open: Record<string, Open>;
  private chain: Promise<void> = Promise.resolve();
  private readonly unsent: string;

  constructor(
    private readonly folder: string,
    private readonly account: string,
    /** Where the engine keeps this folder's conversations. */
    private readonly transcripts: string,
    private readonly send: Sender,
    /** What the manager knows of a conversation. */
    private readonly about: (sessionId: string) => Conversation,
    /** How long after a run ends its transcript lines are surely written. */
    private readonly settleMs = 2000,
  ) {
    this.unsent = join(folder, UNSENT_FILE);
    this.rates = this.readJson<Record<string, number>>(RATES_FILE);
    this.open = this.readJson<Record<string, Open>>(OPEN_FILE);
    const left = Object.entries(this.open);
    if (left.length) {
      this.open = {};
      this.writeOpen();
    }
    for (const [sessionId, o] of left) {
      // its end is its last call, found when it is counted
      this.finish(sessionId, o, { startedAt: o.startedAt, endedAt: 0, outcome: 'restart', error: 'the agent service stopped during the run' });
    }
    // what an earlier lifetime could not send
    if (!left.length && existsSync(this.unsent)) this.flush();
  }

  /** A run began: remembered on disk until it ends. */
  begin(sessionId: string, startedAt: number) {
    this.open = { ...this.open, [sessionId]: { runId: randomUUID(), startedAt } };
    this.writeOpen();
  }

  end(sessionId: string, run: RunEnd) {
    const o = this.open[sessionId] ?? { runId: randomUUID(), startedAt: run.startedAt };
    const { [sessionId]: _done, ...rest } = this.open;
    this.open = rest;
    this.finish(sessionId, o, run);
    this.writeOpen();
  }

  /** Every record has been tried (tests, and a stop that may wait). */
  settled(): Promise<void> {
    return this.chain;
  }

  private finish(sessionId: string, o: Open, run: RunEnd) {
    const c = this.about(sessionId);
    const ended: Ended = {
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
      ...(run.modelUsage ? { modelUsage: run.modelUsage } : {}),
    };
    // on disk before anything else: the process may be about to exit
    try {
      appendFileSync(this.unsent, JSON.stringify(ended) + '\n', { mode: 0o600 });
    } catch (err) {
      console.error(`[runs] could not keep ${o.runId}: ${String(err)}`);
    }
    this.flush();
  }

  private flush() {
    this.chain = this.chain
      .then(() => new Promise((resolve) => setTimeout(resolve, this.settleMs)))
      .then(() => this.deliver())
      .catch((err: unknown) => {
        console.error(`[runs] ${String(err)}`);
      });
  }

  /** The run as the door takes it: its tokens counted and priced. */
  private async record(e: Ended): Promise<RunRecord> {
    const until = e.ended_at || Date.now();
    const count = await countTokens(this.transcripts, e.conversation, e.started_at, until);
    if (e.modelUsage) {
      this.rates = { ...this.rates, ...ratesFrom(e.modelUsage, count.seen) };
      this.writeJson(RATES_FILE, this.rates);
    }
    const { modelUsage: _u, ...rest } = e;
    return {
      ...rest,
      // a run the service died in ends at its last call
      ended_at: e.ended_at || Math.max(e.started_at, count.last),
      // the project's first run: its first conversation, before it said anything
      first: e.first && !count.earlier,
      models: price(count.main, this.rates),
      subagents: price(count.subagents, this.rates),
    };
  }

  /** Send what waits, oldest first; keep whatever was not stored. */
  private async deliver() {
    const waiting = this.readUnsent();
    if (!waiting.length) return;
    const keep: Ended[] = [];
    for (const e of waiting) {
      // once one fails the database is likely away: keep the rest for next time
      if (keep.length) {
        keep.push(e);
        continue;
      }
      const sent = await this.send(await this.record(e));
      if (sent === true) continue;
      if (sent === 'later') {
        keep.push(e);
        continue;
      }
      const tries = (e.tries ?? 0) + 1;
      if (tries >= MAX_TRIES) console.error(`[runs] dropped ${e.run_id} after ${tries} tries: ${JSON.stringify(e).slice(0, 300)}`);
      else keep.push({ ...e, tries });
    }
    // runs that ended while these were sent were appended meanwhile: keep them
    const tried = new Set(waiting.map((e) => e.run_id));
    const rest = [...keep, ...this.readUnsent().filter((e) => !tried.has(e.run_id))];
    if (!rest.length) {
      rmSync(this.unsent, { force: true });
      return;
    }
    const tmp = `${this.unsent}.${process.pid}.tmp`;
    writeFileSync(tmp, rest.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
    renameSync(tmp, this.unsent);
  }

  private readUnsent(): Ended[] {
    let text = '';
    try {
      text = readFileSync(this.unsent, 'utf8');
    } catch {
      return [];
    }
    const out: Ended[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Ended);
      } catch {
        // a torn line: nothing to send
      }
    }
    return out;
  }

  private readJson<T extends object>(name: string): T {
    try {
      return JSON.parse(readFileSync(join(this.folder, name), 'utf8')) as T;
    } catch {
      return {} as T;
    }
  }

  private writeOpen() {
    this.writeJson(OPEN_FILE, this.open);
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
