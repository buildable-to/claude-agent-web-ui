import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { type Query, type SDKMessage, type query } from '@anthropic-ai/claude-agent-sdk';
import type { ServerMessage } from '../shared/protocol.js';
import { SessionManager } from './session-manager.js';
import { WorkJournal } from './work-journal.js';
import { attachWebSocket } from './ws.js';
import { createDrainController } from './drain.js';

function folder(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Only the CLI process is replaced. The real pump, manager, journal, drain
 *  and WebSocket server run, with neither credentials nor model calls. */
function engine() {
  const messages: Array<SDKMessage | Error | null> = [];
  let wake: (() => void) | undefined;
  let params: Parameters<typeof query>[0];
  let launches = 0;
  const prompts: unknown[] = [];
  const factory: typeof query = (args) => {
    launches++;
    params = args;
    args.options?.abortController?.signal.addEventListener('abort', () => { messages.push(null); wake?.(); });
    if (typeof args.prompt !== 'string') {
      void (async () => { for await (const input of args.prompt) prompts.push(input); })();
    }
    const stream = (async function* () {
      while (true) {
        if (!messages.length) await new Promise<void>((resolve) => { wake = resolve; });
        const value = messages.shift();
        if (value === null) return;
        if (value instanceof Error) throw value;
        if (value) yield value;
      }
    })();
    return Object.assign(stream, { interrupt: async () => {}, close: () => {} }) as Query;
  };
  async function emit(message: SDKMessage | Error | null) {
    messages.push(message);
    wake?.();
    await setImmediate();
  }
  return {
    factory, emit, prompts,
    get launches() { return launches; },
    get options() { return params.options; },
    async background(count: number, ambient = false) {
      await emit({ type: 'system', subtype: 'background_tasks_changed', uuid: randomUUID(), session_id: 'test',
        tasks: Array.from({ length: count }, (_, i) => ({ task_id: `builder-${i}`, task_type: 'agent', description: 'Build', ambient })) });
    },
    async idle() {
      await emit({ type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: randomUUID(), session_id: 'test' });
    },
  };
}

test('drain cap persists a stopped-builder notice before abort, once, across restart', async (t) => {
  const dir = folder(t);
  const cli = engine();
  const manager = new SessionManager(dir, undefined, undefined, { queryFactory: cli.factory });
  const session = await manager.open(null);
  session.send('make six builders');
  await cli.background(6);
  await cli.idle();
  assert.equal(session.status, 'idle');
  assert.equal(manager.busy(), 1);
  const seen: ServerMessage[] = [];
  session.subscribe((m) => seen.push(m));
  session.subscribe((m) => {
    if (m.type === 'work_stopped') {
      const disk = JSON.parse(readFileSync(join(dir, '.agent-work.json'), 'utf8'));
      assert.equal(disk.entries[session.sessionId].notices[0].id, m.notice.id);
      assert.equal(cli.options?.abortController?.signal.aborted, false);
    }
  });
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const drain = createDrainController({ busy: () => manager.busy(), stop: () => manager.closeAll() });
  drain.signal('SIGTERM');
  t.mock.timers.tick(25 * 60_000 - 1);
  assert.equal(cli.options?.abortController?.signal.aborted, false);
  t.mock.timers.tick(1);
  await setImmediate();
  const notices = manager.stoppedWork(session.sessionId);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.reason, 'service_stop');
  assert.equal(cli.options?.abortController?.signal.aborted, true);
  assert.equal(seen.filter((m) => m.type === 'work_stopped').length, 1);
  assert.ok(seen.findIndex((m) => m.type === 'work_stopped') < seen.findIndex((m) => m.type === 'status' && m.status === 'closed'));
  const restarted = new SessionManager(dir);
  assert.deepEqual(restarted.stoppedWork(session.sessionId), notices);
  assert.equal(cli.launches, 1, 'reading recovery state cannot start an engine');
  assert.equal(statSync(join(dir, '.agent-work.json')).mode & 0o777, 0o600);
});

test('lost service is detected on read; only the human resume starts a fresh engine', async (t) => {
  const dir = folder(t);
  const old = engine();
  const manager = new SessionManager(dir, undefined, undefined, { queryFactory: old.factory });
  const session = await manager.open(null);
  session.send('make a builder');
  await old.background(1);
  await old.idle();
  // Crash: no close handler is invoked. A new manager reads the last durable level.
  const resumed = engine();
  const next = new SessionManager(dir, undefined, undefined, {
    queryFactory: resumed.factory,
    getSessionMessages: async (_id, options) => { assert.equal(options?.dir, dir); return []; },
    getSessionInfo: async (id, options) => {
      assert.equal(options?.dir, dir);
      return { sessionId: id, lastModified: 1, summary: 'Build', fileSize: 1 };
    },
  });
  const notice = next.stoppedWork(session.sessionId)[0]!;
  assert.equal(notice.reason, 'service_restart');
  assert.equal((await next.history(session.sessionId))[0]?.stoppedWork?.id, notice.id);
  assert.equal(resumed.launches, 0);
  const continued = await next.open(session.sessionId);
  continued.send('continue');
  await setImmediate();
  assert.equal(resumed.launches, 1);
  assert.equal(continued.backgroundWork, 0, 'old task counts must not leak into the new process');
  assert.equal(resumed.prompts.length, 1, 'only the human message is submitted');
  assert.match(JSON.stringify(resumed.options?.systemPrompt), /reconcile writes that already landed/);
  assert.equal(resumed.options?.resume, session.sessionId);
  // The killed predecessor cannot run any more callbacks. Same-process
  // generation fencing is exercised separately on a shared journal below.
  assert.equal(next.stoppedWork(session.sessionId).length, 1);
  continued.close();
});

test('membership replaces counts; ambient tasks and completed work cause no false interruption', async (t) => {
  const cli = engine();
  const dir = folder(t);
  const manager = new SessionManager(dir, undefined, undefined, { queryFactory: cli.factory });
  const session = await manager.open(null);
  await cli.background(6);
  await cli.background(6);
  assert.equal(session.backgroundWork, 6);
  await cli.idle();
  await cli.background(1, true);
  assert.equal(manager.busy(), 0);
  manager.closeAll();
  await setImmediate();
  assert.deepEqual(new SessionManager(dir).stoppedWork(session.sessionId), []);
});

test('CLI exit while Node survives records one notice; late stream data cannot reactivate it', async (t) => {
  const cli = engine();
  const dir = folder(t);
  const manager = new SessionManager(dir, undefined, undefined, { queryFactory: cli.factory });
  const session = await manager.open(null);
  await cli.background(1);
  await cli.idle();
  await cli.emit(new Error('CLI process exited'));
  assert.equal(session.status, 'closed');
  assert.equal(manager.stoppedWork(session.sessionId)[0]?.reason, 'engine_exit');
  await cli.background(3);
  assert.equal(new SessionManager(dir).stoppedWork(session.sessionId).length, 1);
});

test('journal ignores stale generations and retains the last good file on a failed write', (t) => {
  const dir = folder(t);
  const journal = new WorkJournal(dir);
  const old = { sessionId: 'one', generation: 'old', active: true, lastActiveAt: 1 };
  journal.begin(old);
  journal.stop(old, 'service_stop');
  journal.begin({ ...old, generation: 'new' });
  journal.update({ ...old, active: false });
  assert.equal(journal.stop(old, 'engine_exit'), undefined);
  assert.equal(journal.notices('one').length, 1);
  const before = readFileSync(join(dir, '.agent-work.json'), 'utf8');
  // Moving the directory prevents all atomic writes, even when running as root.
  renameSync(dir, `${dir}-moved`);
  t.after(() => rmSync(`${dir}-moved`, { recursive: true, force: true }));
  assert.throws(() => journal.update({ ...old, generation: 'new', active: false }));
  assert.equal(journal.notices('one').length, 1);
  assert.equal(readFileSync(join(`${dir}-moved`, '.agent-work.json'), 'utf8'), before);
  assert.equal(JSON.parse(before).entries.one.active, true);
});

test('concurrent resumes share one engine and pending opens hold the drain', async (t) => {
  const dir = folder(t);
  const cli = engine();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const manager = new SessionManager(dir, undefined, undefined, {
    queryFactory: cli.factory,
    getSessionInfo: async (id) => {
      await waiting;
      return { sessionId: id, lastModified: 1, summary: 'Build', fileSize: 1 };
    },
  });
  const first = manager.open('same');
  const second = manager.open('same');
  assert.equal(manager.busy(), 1);
  assert.equal(cli.launches, 0);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(cli.launches, 1);
  a.close();
});

test('failed resume preserves the original incident and releases the pending drain count', async (t) => {
  const dir = folder(t);
  const journal = new WorkJournal(dir);
  journal.begin({ sessionId: 'session', generation: 'original', active: true, lastActiveAt: 1 });
  const manager = new SessionManager(dir, undefined, undefined, {
    queryFactory: () => { throw new Error('Could not spawn CLI'); },
    getSessionInfo: async (id) => ({ sessionId: id, lastModified: 1, summary: 'Build', fileSize: 1 }),
  });
  await assert.rejects(manager.open('session'), /Could not spawn CLI/);
  assert.equal(manager.busy(), 0);
  assert.equal(manager.stoppedWork('session')[0]?.id, 'original');
  assert.equal(manager.stoppedWork('session')[1]?.reason, 'engine_exit');
  assert.deepEqual(new SessionManager(dir).stoppedWork('session'), manager.stoppedWork('session'));
});

test('history places repeated incidents in order before later resumed messages', async (t) => {
  const dir = folder(t);
  const journal = new WorkJournal(dir);
  for (const generation of ['first', 'second']) {
    const state = { sessionId: 'session', generation, active: true, lastActiveAt: 1, afterMessageUuid: 'anchor' };
    journal.begin(state);
    journal.stop(state, 'engine_exit');
  }
  const manager = new SessionManager(dir, undefined, undefined, {
    getSessionMessages: async () => ['anchor', 'resumed'].map((uuid) => ({
      type: 'user', uuid, session_id: 'session', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: uuid },
    })),
  });
  assert.deepEqual((await manager.history('session')).map((m) => m.uuid), ['anchor', 'first', 'second', 'resumed']);
  assert.deepEqual(await manager.history('different-account-id'), [
    // The injected SDK store above supplies these records for any id, but
    // the journal must never append another session's interruption notices.
    ...((await manager.history('session')).filter((m) => !m.stoppedWork)),
  ]);
});

test('a failed first background-state write still records the resulting engine stop', async (t) => {
  const cli = engine();
  const dir = folder(t);
  const manager = new SessionManager(dir, undefined, undefined, { queryFactory: cli.factory });
  const session = await manager.open(null);
  await cli.idle();
  const original = WorkJournal.prototype.update;
  let fail = true;
  t.mock.method(WorkJournal.prototype, 'update', function (this: WorkJournal, state: Parameters<typeof original>[0]) {
    if (fail && state.active) { fail = false; throw new Error('temporary write failure'); }
    return original.call(this, state);
  });
  await cli.background(1);
  assert.equal(session.status, 'closed');
  assert.equal(manager.stoppedWork(session.sessionId)[0]?.reason, 'engine_exit');
  assert.equal(new SessionManager(dir).stoppedWork(session.sessionId).length, 1);
});

test('crash recovery follows the last completed message, not an earlier task transition', async (t) => {
  const cli = engine();
  const dir = folder(t);
  const manager = new SessionManager(dir, undefined, undefined, { queryFactory: cli.factory });
  const session = await manager.open(null);
  session.send('work');
  await cli.background(1);
  const uuid = randomUUID();
  await cli.emit({ type: 'user', uuid, session_id: session.sessionId, parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'saved', content: 'SAVED as e1' }] } });
  const recovered = new SessionManager(dir);
  assert.equal(recovered.stoppedWork(session.sessionId)[0]?.afterMessageUuid, uuid);
});

test('unreadable recovery state fails visibly instead of silently discarding active work', (t) => {
  const dir = folder(t);
  writeFileSync(join(dir, '.agent-work.json'), '{broken');
  assert.throws(() => new WorkJournal(dir));
  assert.equal(readFileSync(join(dir, '.agent-work.json'), 'utf8'), '{broken');
});

test('reconnected WebSocket gets durable notices without starting Claude; another account cannot see them', async (t) => {
  const a = folder(t), b = folder(t);
  const journal = new WorkJournal(a);
  journal.begin({ sessionId: 'interrupted', generation: 'incident', active: true, lastActiveAt: 1 });
  const cli = engine();
  const managers = {
    a: new SessionManager(a, undefined, undefined, { queryFactory: cli.factory }),
    b: new SessionManager(b, undefined, undefined, { queryFactory: cli.factory }),
  };
  const server = createServer();
  const wss = attachWebSocket(server, (token) => {
    const manager = token === 'a' ? managers.a : managers.b;
    return { manager, dir: manager.projectDir };
  });
  const sockets: WebSocket[] = [];
  t.after(() => { for (const ws of sockets) ws.terminate(); wss.close(); server.close(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const port = addr.port;
  async function attach(account: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${account}`);
    sockets.push(ws);
    await new Promise<void>((resolve) => ws.once('open', resolve));
    const response = new Promise<ServerMessage>((resolve) => ws.once('message', (raw) => resolve(JSON.parse(String(raw)))));
    ws.send(JSON.stringify({ type: 'attach', sessionId: 'interrupted' }));
    return response;
  }
  const first = await attach('a');
  assert.equal(first.type, 'not_live');
  assert.ok(first.type === 'not_live' && first.stoppedWork.length === 1);
  assert.deepEqual(await attach('a'), first);
  const other = await attach('b');
  assert.ok(other.type === 'not_live' && other.stoppedWork.length === 0);
  assert.equal(cli.launches, 0);
});
