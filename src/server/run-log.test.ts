import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { ModelUsage, Query, SDKMessage, query } from '@anthropic-ai/claude-agent-sdk';
import { RunLog, countTokens, doorSender, price, ratesFrom, type RunRecord, type Sent } from './run-log.js';
import { SessionManager, transcriptDir } from './session-manager.js';

function folder(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const T = Date.parse('2026-11-08T10:00:00.000Z');
const at = (s: number) => new Date(T + s * 1000).toISOString();

function call(id: string, s: number, usage: Record<string, unknown>, extra: Record<string, unknown> = {}, model = 'claude-opus-5-5') {
  return JSON.stringify({ type: 'assistant', timestamp: at(s), ...extra, message: { id, model, role: 'assistant', content: [], usage } });
}

function usage(input: number, output: number, read = 0, write = 0) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    cache_creation: { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 },
  };
}

function modelUsage(u: Partial<ModelUsage>): ModelUsage {
  return {
    inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    webSearchRequests: 0, costUSD: 0, contextWindow: 200_000, maxOutputTokens: 32_000, ...u,
  };
}

test('a run spends what its calls in its window cost, each call once, sub-agents apart', async (t) => {
  const dir = folder(t);
  mkdirSync(join(dir, 'c1', 'subagents'), { recursive: true });
  writeFileSync(join(dir, 'c1.jsonl'), [
    JSON.stringify({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'hi' } }),
    // one API call, written once per content block: the last carries its output
    call('m1', 1, usage(10, 3, 100, 50)),
    call('m1', 2, usage(10, 40, 100, 50)),
    call('m2', 5, usage(2, 7, 900, 0)),
    call('m0', -100, usage(999, 999)),                     // an earlier run
    call('e1', 6, usage(0, 0), {}, '<synthetic>'),         // an API error, no call
    call('s0', 7, usage(1, 1), { isSidechain: true }),     // an old-style sub-agent line
    '{"type":"assistant","timestamp":"' + at(8),            // torn last line
  ].join('\n'));
  writeFileSync(join(dir, 'c1', 'subagents', 'agent-a.jsonl'), [
    call('s1', 4, usage(5, 20, 300, 10), {}, 'claude-haiku-5-5'),
    call('s2', 4, usage(1, 2, 0, 0)),
  ].join('\n'));
  const c = await countTokens(dir, 'c1', T, T + 60_000);
  assert.deepEqual(c.main, { 'claude-opus-5-5': { input: 12, output: 47, cache_read: 1000, cache_write: 50, cache_write_1h: 50 } });
  assert.deepEqual(c.subagents, {
    'claude-haiku-5-5': { input: 5, output: 20, cache_read: 300, cache_write: 10, cache_write_1h: 10 },
    'claude-opus-5-5': { input: 2, output: 3, cache_read: 0, cache_write: 0, cache_write_1h: 0 },
  });
  assert.equal(c.last, T + 7000);
  assert.equal(c.earlier, true, 'the conversation ran before');
  // every call up to the end, the earlier run's too: what the rates are read against
  assert.equal(c.seen['claude-opus-5-5']!.input, 12 + 2 + 999);
  assert.deepEqual(await countTokens(dir, 'nobody', T, T + 60_000), { main: {}, subagents: {}, seen: {}, earlier: false, last: 0, found: false });
  // a sub-agent's call before the run does not make it a later run
  assert.equal((await countTokens(dir, 'c1', T - 50_000, T + 60_000)).earlier, true);
  assert.equal((await countTokens(dir, 'c1', T - 200_000, T + 60_000)).earlier, false);
});

test("a model's price comes from the engine's own totals; an unknown model has no dollars", () => {
  // $5 per million input tokens: 1M input + 0.1M output (x5) + 1M read (x0.1) + 0.1M hour writes (x2)
  const rates = ratesFrom({
    'claude-opus-5-5[1m]': modelUsage({ inputTokens: 1e6, outputTokens: 1e5, cacheReadInputTokens: 1e6, cacheCreationInputTokens: 1e5, costUSD: 5 * 1.8 }),
    'claude-haiku-5-5': modelUsage({ inputTokens: 10 }),        // no cost yet: says nothing
  });
  assert.deepEqual(Object.keys(rates), ['claude-opus-5-5']);
  assert.ok(Math.abs(rates['claude-opus-5-5']! - 5e-6) < 1e-12);
  const priced = price({
    'claude-opus-5-5': { input: 1000, output: 1000, cache_read: 10_000, cache_write: 1000, cache_write_1h: 0 },
    'claude-fable-5-1': { input: 1, output: 1, cache_read: 0, cache_write: 0, cache_write_1h: 0 },
  }, rates);
  // 1000 + 5000 + 1000 + 1000 x 1.25 (five-minute writes) = 8250 input tokens' worth
  assert.equal(priced['claude-opus-5-5']!.usd, 0.04125);
  assert.equal(priced['claude-fable-5-1']!.usd, null);
  assert.equal('cache_write_1h' in priced['claude-opus-5-5']!, false);
});

test("five-minute cache writes (the sub-agents') are read from the transcripts, not taken for hour-long ones", () => {
  // $5/M input; 1M five-minute writes (x1.25) cost $6.25; taken for hour-long (x2) the rate would read low
  const usage = { 'claude-opus-5-5': modelUsage({ cacheCreationInputTokens: 1e6, costUSD: 6.25, canonicalModel: 'claude-opus-5-5' }) };
  const seen = { 'claude-opus-5-5': { input: 0, output: 0, cache_read: 0, cache_write: 1000, cache_write_1h: 0 } };
  assert.ok(Math.abs(ratesFrom(usage, seen)['claude-opus-5-5']! - 5e-6) < 1e-12);
  assert.ok(ratesFrom(usage)['claude-opus-5-5']! < 4e-6, 'without the transcripts: all hour-long');
  // an alias key is priced under the model the transcripts name
  assert.deepEqual(Object.keys(ratesFrom({ opus: modelUsage({ inputTokens: 1, costUSD: 1, canonicalModel: 'claude-opus-5-5' }) })).sort(), ['claude-opus-5-5', 'opus']);
});

function log(t: TestContext, send: (r: RunRecord) => Promise<Sent>) {
  const dir = folder(t);
  const transcripts = join(dir, 'transcripts');
  mkdirSync(transcripts);
  const runs = new RunLog(dir, 'u1', transcripts, send, () => ({ project: 'p1', scope: 'project', first: true }), 0);
  return { dir, transcripts, runs };
}

test('a record the database could not take waits in the folder and goes first next time', async (t) => {
  let up = false;
  const sent: string[] = [];
  const { dir, runs } = log(t, async (r) => {
    if (up) sent.push(r.run_id);
    return up;
  });
  runs.begin('c1', T);
  runs.end('c1', { startedAt: T, endedAt: T + 1000, outcome: 'ok' });
  const unsent = join(dir, '.agent-runs-unsent.jsonl');
  // on disk the moment it ends, before any sending: a deploy may exit next
  assert.equal(readFileSync(unsent, 'utf8').trim().split('\n').length, 1);
  await runs.settled();
  const waiting = readFileSync(unsent, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as RunRecord);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0]!.tries, 1);
  assert.equal(waiting[0]!.project, 'p1');
  up = true;
  runs.begin('c2', T + 5000);
  runs.end('c2', { startedAt: T + 5000, endedAt: T + 6000, outcome: 'error', error: 'boom' });
  await runs.settled();
  assert.equal(sent.length, 2);
  assert.equal(sent[0], waiting[0]!.run_id, 'the older record first');
  assert.equal(existsSync(unsent), false);
});

test('one record the door always refuses is dropped in the end, never blocking the rest', async (t) => {
  const { dir, runs } = log(t, async () => false);
  t.mock.method(console, 'error', () => undefined);
  for (let i = 0; i < 25; i++) {
    runs.end(`c${i}`, { startedAt: T, endedAt: T + 1, outcome: 'ok' });
  }
  await runs.settled();
  const waiting = readFileSync(join(dir, '.agent-runs-unsent.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as RunRecord);
  // the first record was tried every time and is gone; the rest wait
  assert.ok(waiting.every((r) => r.conversation !== 'c0'));
  assert.equal(waiting[0]!.conversation, 'c1');
});

test("while this server's app has no door yet, records wait and keep their tries", async (t) => {
  let door: Sent = 'later';
  const sent: string[] = [];
  const { dir, runs } = log(t, async (r) => {
    if (door === true) sent.push(r.run_id);
    return door;
  });
  for (let i = 0; i < 25; i++) runs.end(`c${i}`, { startedAt: T, endedAt: T + 1, outcome: 'ok' });
  await runs.settled();
  const waiting = readFileSync(join(dir, '.agent-runs-unsent.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as RunRecord);
  assert.equal(waiting.length, 25);
  assert.ok(waiting.every((r) => !r.tries));
  door = true;
  runs.end('c-last', { startedAt: T, endedAt: T + 1, outcome: 'ok' });
  await runs.settled();
  assert.equal(sent.length, 26);
});

test('the door sender waits when the checkout has no door yet', async (t) => {
  const repo = folder(t);
  assert.equal(await doorSender({ BUILDABLE_REPO: repo })({} as RunRecord), 'later');
});

test('a run the service died in is recorded as cut by a restart when it comes back', async (t) => {
  const dir = folder(t);
  const transcripts = join(dir, 'transcripts');
  mkdirSync(transcripts);
  writeFileSync(join(transcripts, 'c1.jsonl'), call('m1', 30, usage(10, 10)) + '\n');
  writeFileSync(join(dir, '.agent-runs-open.json'), JSON.stringify({ c1: { runId: 'r-crashed', startedAt: T } }));
  writeFileSync(join(dir, '.agent-rates.json'), JSON.stringify({ 'claude-opus-5-5': 1e-6 }));
  const sent: RunRecord[] = [];
  const runs = new RunLog(dir, 'u1', transcripts, async (r) => (sent.push(r), true), () => ({ project: null, scope: 'library', first: false }), 0);
  await runs.settled();
  assert.equal(sent.length, 1);
  const r = sent[0]!;
  assert.equal(r.run_id, 'r-crashed');
  assert.equal(r.outcome, 'restart');
  assert.equal(r.ended_at, T + 30_000, 'ends at its last call');
  assert.equal(r.models['claude-opus-5-5']!.usd, 0.00006);
  assert.equal(JSON.parse(readFileSync(join(dir, '.agent-runs-open.json'), 'utf8')).c1, undefined);
});

test('a cut run is counted once, up to the next run of its conversation, and keeps that while it waits', async (t) => {
  const dir = folder(t);
  const transcripts = join(dir, 'transcripts');
  mkdirSync(transcripts);
  writeFileSync(join(transcripts, 'c1.jsonl'), [call('m1', 30, usage(10, 10)), call('m2', 200, usage(500, 500))].join('\n') + '\n');
  writeFileSync(join(dir, '.agent-runs-open.json'), JSON.stringify({ c1: { runId: 'r-cut', startedAt: T } }));
  // the engineer's "continue" ran from T+100 s and is waiting to be sent too
  writeFileSync(join(dir, '.agent-runs-unsent.jsonl'), JSON.stringify({ run_id: 'r-next', account: 'u1', project: null, scope: null,
    conversation: 'c1', first: false, started_at: T + 100_000, ended_at: T + 300_000, outcome: 'ok' }) + '\n');
  const sent: RunRecord[] = [];
  let door: Sent = 'later';
  const runs = new RunLog(dir, 'u1', transcripts, async (r) => (door === true && sent.push(r), door), () => ({ project: null, scope: null, first: false }), 0);
  await runs.settled();
  const kept = readFileSync(join(dir, '.agent-runs-unsent.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as RunRecord);
  const cut = kept.find((r) => r.run_id === 'r-cut')!;
  assert.equal(cut.ended_at, T + 30_000);
  assert.equal(cut.models['claude-opus-5-5']!.input, 10, "not the next run's call");
  door = true;
  runs.end('c2', { startedAt: T, endedAt: T + 1, outcome: 'ok' });
  await runs.settled();
  assert.deepEqual(sent.map((r) => [r.run_id, r.models['claude-opus-5-5']?.input]), [['r-next', 500], ['r-cut', 10], [sent[2]!.run_id, undefined]]);
});

test('a run whose transcript is gone says its cost is unknown', async (t) => {
  const sent: RunRecord[] = [];
  const { runs } = log(t, async (r) => (sent.push(r), true));
  runs.end('gone', { startedAt: T, endedAt: T + 1, outcome: 'ok' });
  await runs.settled();
  assert.equal(sent[0]!.tokens_unknown, true);
});

/** Only the CLI process is replaced (as in recovery.test.ts). */
function engine() {
  const messages: Array<SDKMessage | null> = [];
  let wake: (() => void) | undefined;
  const factory: typeof query = (args) => {
    args.options?.abortController?.signal.addEventListener('abort', () => { messages.push(null); wake?.(); });
    if (typeof args.prompt !== 'string') void (async () => { for await (const _ of args.prompt) { /* consumed */ } })();
    const stream = (async function* () {
      while (true) {
        if (!messages.length) await new Promise<void>((resolve) => { wake = resolve; });
        const value = messages.shift();
        if (value === null || value === undefined) return;
        yield value;
      }
    })();
    return Object.assign(stream, { interrupt: async () => undefined, stopTask: async () => undefined, close: () => {} }) as unknown as Query;
  };
  async function emit(message: SDKMessage) {
    messages.push(message);
    wake?.();
    await setImmediate();
  }
  const base = { uuid: randomUUID(), session_id: 'test' };
  return {
    factory,
    emit,
    async state(state: 'idle' | 'running') {
      await emit({ type: 'system', subtype: 'session_state_changed', state, ...base, uuid: randomUUID() } as SDKMessage);
    },
    async background(count: number) {
      await emit({ type: 'system', subtype: 'background_tasks_changed', ...base, uuid: randomUUID(),
        tasks: Array.from({ length: count }, (_, i) => ({ task_id: `b${i}`, task_type: 'agent', description: 'Build', ambient: false })) } as SDKMessage);
    },
    async result(ok: boolean, cost = 0.5) {
      await emit({
        type: 'result', subtype: ok ? 'success' : 'error_during_execution', is_error: !ok, result: 'done',
        errors: ok ? undefined : ['the tool failed'], duration_ms: 1, duration_api_ms: 1, num_turns: 3, stop_reason: null,
        total_cost_usd: cost, usage: {}, permission_denials: [], ...base, uuid: randomUUID(),
        modelUsage: { 'claude-opus-5-5': modelUsage({ inputTokens: 1e6, costUSD: cost }) },
      } as unknown as SDKMessage);
    },
  };
}

async function manager(t: TestContext) {
  const home = folder(t);
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; });
  const dir = folder(t);
  const cli = engine();
  const sent: RunRecord[] = [];
  const m = new SessionManager(dir, 'u1', { value: { commands: [], models: [] }, probe: null }, {
    queryFactory: cli.factory,
    sendRun: async (r) => (sent.push(r), true),
    runSettleMs: 0,
  });
  mkdirSync(transcriptDir(dir), { recursive: true });
  return { m, cli, sent, dir };
}

test('a run lasts until all is quiet: its sub-agents too; the first chat of a project is "first"', async (t) => {
  const { m, cli, sent } = await manager(t);
  const s = await m.open(null, { project: 'p1', firstPrompt: 'Make the columns' });
  s.send('Make the columns');
  await cli.state('running');
  await cli.background(2);
  await cli.result(true);
  await cli.state('idle');
  assert.equal(sent.length, 0, 'builders still at work');
  await cli.background(0);
  await (m as unknown as { runs: RunLog }).runs.settled();
  assert.equal(sent.length, 1);
  const r = sent[0]!;
  assert.deepEqual([r.account, r.project, r.scope, r.conversation, r.title, r.first, r.outcome, r.turns],
    ['u1', 'p1', 'project', s.sessionId, 'Make the columns', true, 'ok', 3]);
  assert.ok(r.ended_at >= r.started_at);
  // a second conversation about the same project is a revision
  const s2 = await m.open(null, { project: 'p1', firstPrompt: 'Change C-1' });
  s2.send('Change C-1');
  await cli.result(false);
  await cli.state('idle');
  await (m as unknown as { runs: RunLog }).runs.settled();
  assert.equal(sent.length, 2);
  assert.deepEqual([sent[1]!.first, sent[1]!.outcome, sent[1]!.error], [false, 'error', 'error_during_execution: the tool failed']);
  m.closeAll();
});

test('only the first run of the first conversation is the first; its next message is a revision', async (t) => {
  const { m, cli, sent, dir } = await manager(t);
  const s = await m.open(null, { project: 'p1', firstPrompt: 'Make it' });
  const tr = transcriptDir(dir);
  s.send('Make it');
  writeFileSync(join(tr, `${s.sessionId}.jsonl`), call('m1', -1, usage(1, 1)).replace(at(-1), new Date(Date.now()).toISOString()) + '\n');
  await cli.result(true);
  await cli.state('idle');
  await (m as unknown as { runs: RunLog }).runs.settled();
  await new Promise((r) => setTimeout(r, 5));
  s.send('Now the sheets');
  await cli.result(true);
  await cli.state('idle');
  await (m as unknown as { runs: RunLog }).runs.settled();
  // the first conversation both times; the second run comes after it spoke
  assert.deepEqual(sent.map((r) => [r.first, r.earlier]), [[true, false], [true, true]]);
  m.closeAll();
});

test('Stop on background work alone ends the run as stopped', async (t) => {
  const { m, cli, sent } = await manager(t);
  const s = await m.open(null, { project: 'p1' });
  s.send('six builders');
  await cli.background(6);
  await cli.result(true);
  await cli.state('idle');
  await s.interrupt();
  await cli.background(0);
  await (m as unknown as { runs: RunLog }).runs.settled();
  assert.deepEqual(sent.map((r) => r.outcome), ['stopped']);
  m.closeAll();
});

test('an idle chat closed hours later keeps its turns\' outcome; one with none is an error', async (t) => {
  const { m, cli, sent } = await manager(t);
  const s = await m.open(null, { project: 'p1' });
  s.send('builders');
  await cli.background(1);
  await cli.result(true);
  await cli.state('idle');
  s.close('idle_timeout');
  await (m as unknown as { runs: RunLog }).runs.settled();
  assert.deepEqual(sent.map((r) => r.outcome), ['ok']);
});

test('Stop and a restart under a run end it as stopped and as cut by a restart', async (t) => {
  const { m, cli, sent } = await manager(t);
  const s = await m.open(null, { project: 'p1' });
  s.send('go');
  await cli.state('running');
  await m.stop(s.sessionId);
  const s2 = await m.open(null, { project: 'p1' });
  s2.send('go again');
  await cli.state('running');
  m.closeAll();
  await (m as unknown as { runs: RunLog }).runs.settled();
  assert.deepEqual(sent.map((r) => r.outcome), ['stopped', 'restart']);
  assert.match(sent[1]!.error ?? '', /restart/);
  // a quiet engine closing (an idle chat) records nothing
  const s3 = await m.open(null, { project: 'p1' });
  s3.close('idle_timeout');
  await (m as unknown as { runs: RunLog }).runs.settled();
  assert.equal(sent.length, 2);
});
