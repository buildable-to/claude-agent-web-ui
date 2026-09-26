import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { query, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { WebSocket } from 'ws';
import type { ServerMessage } from '../shared/protocol.js';
import { LiveSession } from './live-session.js';
import { SessionManager } from './session-manager.js';
import { attachWebSocket } from './ws.js';

async function until(predicate: () => boolean, description: string, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await delay(10);
  }
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('account Stop work cancels real SDK task workers and its subprocess, with durable feedback', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-stop-sdk-'));
  const otherDirectory = mkdtempSync(join(tmpdir(), 'agent-stop-other-'));
  const children: ChildProcess[] = [];
  const workerIds: number[] = [];
  t.after(() => {
    for (const child of children) child.kill('SIGKILL');
    for (const pid of workerIds) if (alive(pid)) process.kill(pid, 'SIGKILL');
    rmSync(directory, { recursive: true, force: true });
    rmSync(otherDirectory, { recursive: true, force: true });
  });
  const manager = new SessionManager(directory, undefined, undefined, {
    // Use the installed SDK's real query, protocol and process transport.
    // Only its CLI executable is replaced by a credential-free inert fixture.
    queryFactory: (parameters) => query({ ...parameters, options: {
      ...parameters.options,
      spawnClaudeCodeProcess: () => {
        const child = spawn(process.execPath, [
          fileURLToPath(new URL('./fixtures/inert-task-engine.cjs', import.meta.url)),
          directory, parameters.options!.sessionId!,
        ], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
        children.push(child);
        return child;
      },
    } }),
  });
  const other = new SessionManager(otherDirectory, undefined, undefined, {
    queryFactory: () => { throw new Error('Cross-account stop must not launch an engine'); },
  });
  t.after(() => { manager.closeAll(); other.closeAll(); });
  const session = await manager.open(null);
  session.send('Build two pieces');
  await until(() => session.status === 'idle' && session.backgroundWork === 2, 'foreground finished, builders running');
  for (const id of ['builder-0', 'builder-1']) {
    workerIds.push(Number(readFileSync(join(directory, `${id}.pid`), 'utf8')));
  }
  assert.ok(workerIds.every(alive));
  const enginePid = Number(readFileSync(join(directory, 'engine.pid'), 'utf8'));
  assert.ok(alive(enginePid));

  const server = createServer();
  const wss = attachWebSocket(server, (token) => {
    const accountManager = token === 'owner' ? manager : other;
    return { manager: accountManager, dir: accountManager.projectDir };
  });
  const sockets: WebSocket[] = [];
  t.after(() => { for (const socket of sockets) socket.terminate(); wss.close(); server.close(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  async function connect(token: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${(address as { port: number }).port}/ws?token=${token}`);
    sockets.push(socket);
    const events: ServerMessage[] = [];
    socket.on('message', (raw) => events.push(JSON.parse(String(raw)) as ServerMessage));
    await new Promise<void>((resolve) => socket.once('open', resolve));
    return { socket, events };
  }
  const intruder = await connect('other');
  intruder.socket.send(JSON.stringify({ type: 'stop_work', sessionId: session.sessionId }));
  await until(() => intruder.events.length > 0, 'cross-account stop response');
  assert.deepEqual(intruder.events[0], { type: 'not_live', sessionId: session.sessionId, stoppedWork: [] });
  assert.ok(workerIds.every(alive), 'another account cannot stop these descendants');

  const owner = await connect('owner');
  owner.socket.send(JSON.stringify({ type: 'attach', sessionId: session.sessionId }));
  await until(() => owner.events.some((message) => message.type === 'attached'), 'attachment');
  const attached = owner.events.find((message) => message.type === 'attached');
  assert.equal(attached?.type === 'attached' && attached.backgroundWork, 2);
  owner.socket.send(JSON.stringify({ type: 'stop_work', sessionId: session.sessionId }));
  await until(() => owner.events.some((message) => message.type === 'work_stopped'), 'durable notice');
  await session.stopWork();
  assert.ok(workerIds.every((pid) => !alive(pid)) && !alive(enginePid), 'Stop resolves after workers and CLI terminate');
  await until(() => session.status === 'closed', 'session closes');
  assert.equal(manager.get(session.sessionId), undefined);
  assert.equal(manager.busy(), 0);
  assert.equal(session.backgroundWork, 0);
  assert.deepEqual(session.pendingRequests, []);
  assert.throws(() => session.send('late work'), /closed/);
  const notices = manager.stoppedWork(session.sessionId);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.reason, 'user_stop');
  assert.deepEqual(new SessionManager(directory).stoppedWork(session.sessionId), notices);
  const log = readFileSync(join(directory, 'engine.log'), 'utf8');
  assert.equal(log.match(/control stop_task/g)?.length, 2);
  assert.match(log, /stopped builder-0/);
  assert.match(log, /stopped builder-1/);
  assert.match(log, /stdin closed/);
  // Repeated cancellation returns existing state instead of resuming work.
  owner.socket.send(JSON.stringify({ type: 'stop_work', sessionId: session.sessionId }));
  await until(() => owner.events.some((message) => message.type === 'not_live'), 'idempotent stop');
  assert.equal(manager.stoppedWork(session.sessionId).length, 1);
});

test('Stop discards unread queued prompts and denies permissions requested during cancellation', async () => {
  let parameters: Parameters<typeof query>[0] | undefined;
  let finish!: () => void;
  let closed = 0;
  const queryFactory: typeof query = (value) => {
    parameters = value;
    const stream = (async function* (): AsyncGenerator<SDKMessage> {
      await new Promise<void>((resolve) => { finish = resolve; });
    })();
    return Object.assign(stream, {
      close: () => { closed++; finish(); }, interrupt: async () => {}, stopTask: async (_id: string) => {},
    }) as Query;
  };
  const session = new LiveSession({ cwd: tmpdir(), queryFactory });
  session.send('first');
  session.send('queued');
  await session.stopWork();
  assert.equal(closed, 1);
  assert.ok(parameters && typeof parameters.prompt !== 'string');
  const input = parameters.prompt[Symbol.asyncIterator]();
  assert.equal((await input.next()).done, true, 'closed queue must not yield its previously buffered inputs');
  const permission = await parameters.options!.canUseTool!('Bash', {}, {
    signal: new AbortController().signal, toolUseID: 'late', requestId: 'late',
  });
  assert.ok(permission);
  assert.equal(permission.behavior, 'deny');
  assert.deepEqual(session.pendingRequests, []);
});

test('a stuck task cancellation is bounded, and ambient or completed tasks are never stopped', async (t) => {
  let session!: LiveSession;
  let finish!: () => void;
  const stoppedTasks: string[] = [];
  const emitted: SDKMessage[] = [];
  let wake!: () => void;
  const queryFactory: typeof query = () => {
    const stream = (async function* () {
      while (true) {
        await new Promise<void>((resolve) => { wake = resolve; finish = resolve; });
        if (!emitted.length) return;
        yield emitted.shift()!;
      }
    })();
    return Object.assign(stream, {
      close: () => finish(),
      stopTask: async (id: string) => { stoppedTasks.push(id); await new Promise<void>(() => {}); },
    }) as Query;
  };
  session = new LiveSession({ cwd: tmpdir(), queryFactory });
  t.after(() => session.close());
  emitted.push({ type: 'system', subtype: 'background_tasks_changed', uuid: randomUUID(), session_id: session.sessionId,
    tasks: [
      { task_id: 'builder', task_type: 'agent', description: 'Build', ambient: false },
      { task_id: 'housekeeping', task_type: 'agent', description: 'Watch', ambient: true },
    ] });
  wake();
  await until(() => session.backgroundWork === 1, 'task membership');
  const start = Date.now();
  const first = session.stopWork();
  assert.equal(session.stopWork(), first);
  await first;
  assert.ok(Date.now() - start < 4000, 'a missing task acknowledgement must not block closing');
  assert.deepEqual(stoppedTasks, ['builder']);
  assert.equal(session.status, 'closed');
});

test('concurrent resumes during a slow Stop share one fresh engine after teardown', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-stop-resume-'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
  let launches = 0;
  const queryFactory: typeof query = () => {
    const index = launches++;
    let finish!: () => void;
    const stream = (async function* (): AsyncGenerator<SDKMessage> {
      yield { type: 'system', subtype: 'background_tasks_changed', uuid: randomUUID(), session_id: 'test', tasks: [
        { task_id: 'builder', task_type: 'agent', description: 'Build', ambient: false },
      ] };
      yield { type: 'system', subtype: 'session_state_changed', uuid: randomUUID(), session_id: 'test', state: 'idle' };
      await new Promise<void>((resolve) => { finish = resolve; });
    })();
    return Object.assign(stream, {
      close: () => finish?.(), interrupt: async () => {},
      stopTask: async (_id: string) => { if (index === 0) await gate; },
      return: async () => { if (index === 0) await cleanup; return { done: true as const, value: undefined }; },
    }) as Query;
  };
  const manager = new SessionManager(directory, undefined, undefined, {
    queryFactory,
    getSessionInfo: async (sessionId) => ({ sessionId, lastModified: 1, fileSize: 1, summary: 'Build' }),
  });
  t.after(() => {
    manager.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });
  const previous = await manager.open(null);
  await until(() => previous.status === 'idle' && previous.backgroundWork === 1, 'old builder active');
  const stopping = manager.stop(previous.sessionId);
  assert.equal(previous.isStopping, true);
  const firstResume = manager.open(previous.sessionId);
  const secondResume = manager.open(previous.sessionId);
  await delay(20);
  assert.equal(launches, 1, 'neither resume can start while the predecessor is stopping');
  assert.throws(() => previous.send('late followup'), /closed/);
  release();
  await until(() => previous.status === 'closed', 'close begins SDK cleanup');
  assert.equal(launches, 1, 'closed status alone cannot release a still-terminating SDK process');
  assert.equal(manager.get(previous.sessionId), previous);
  finishCleanup();
  const [first, second] = await Promise.all([firstResume, secondResume]);
  await stopping;
  assert.equal(previous.status, 'closed');
  assert.notEqual(first, previous);
  assert.equal(first, second);
  assert.equal(launches, 2);
  assert.equal(manager.get(previous.sessionId), first, 'old stop cannot remove the resumed generation');
  assert.equal(manager.stoppedWork(previous.sessionId).length, 1);
  first.send('continue');
});
