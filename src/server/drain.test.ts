import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionManager } from './session-manager.js';
import { LiveSession } from './live-session.js';
import { createDrainController } from './drain.js';

test('deploy drain waits for builders after the coordinator turn ends', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const dir = mkdtempSync(join(tmpdir(), 'agent-drain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = new SessionManager(dir);
  // Substitute the process boundary only. The drain calls this manager's
  // actual busy() and reads the SDK's current background-work level.
  const session = Object.assign(Object.create(LiveSession.prototype), {
    status: 'idle', backgroundWork: 6,
  });
  t.mock.method(manager, 'liveSessions', () => [session]);
  const intervals = t.mock.method(globalThis, 'setInterval');
  const cleared = t.mock.method(globalThis, 'clearInterval');
  const stopped: string[] = [];
  const busy = t.mock.fn(() => manager.busy());
  const drain = createDrainController({ busy, stop: (reason) => stopped.push(reason) });
  drain.signal('SIGTERM');
  assert.equal(drain.draining, true, 'new turns must be blocked throughout the drain');
  assert.equal(manager.busy(), 1, 'an idle coordinator with six builders is still busy');
  t.mock.timers.tick(60_000);
  assert.deepEqual(stopped, [], 'builders must not be cut when their coordinator becomes idle');
  session.backgroundWork = 0;
  assert.equal(manager.busy(), 0, 'settled builders release the drain');
  t.mock.timers.tick(1000);
  assert.equal(stopped.length, 1);
  assert.match(stopped[0]!, /drained/);
  // Node 20's mocked interval requeues after clearing itself inside its callback;
  // assert cancellation directly rather than relying on that mock behavior.
  assert.equal(cleared.mock.callCount(), 1);
  assert.equal(cleared.mock.calls[0]!.arguments[0], intervals.mock.calls[0]!.result);
  session.status = 'running';
  assert.equal(manager.busy(), 1, 'foreground work still holds the drain');
  t.mock.timers.tick(25 * 60_000);
  assert.equal(stopped.length, 1);
});

test('an empty server stops immediately on its first signal', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const stopped: string[] = [];
  const drain = createDrainController({ busy: () => 0, stop: (reason) => stopped.push(reason) });
  assert.equal(drain.draining, false);
  drain.signal('SIGINT');
  assert.equal(drain.draining, true);
  assert.equal(stopped.length, 1);
  assert.match(stopped[0]!, /no active work/);
  drain.signal('SIGTERM');
  t.mock.timers.tick(25 * 60_000);
  assert.equal(stopped.length, 1, 'the process-stop callback runs once');
});

test('work that never settles stops at the default 25-minute cap', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const stopped: string[] = [];
  const drain = createDrainController({ busy: () => 1, stop: (reason) => stopped.push(reason) });
  drain.signal('SIGTERM');
  t.mock.timers.tick(25 * 60_000 - 1);
  assert.deepEqual(stopped, []);
  t.mock.timers.tick(1);
  assert.equal(stopped.length, 1);
  assert.match(stopped[0]!, /timed out.*1 session/);
  t.mock.timers.tick(60_000);
  assert.equal(stopped.length, 1);
});

test('the configured drain deadline is honored', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const stopped: string[] = [];
  const drain = createDrainController({ busy: () => 2, stop: (reason) => stopped.push(reason), timeoutMs: 3000 });
  drain.signal('SIGTERM');
  t.mock.timers.tick(2999);
  assert.deepEqual(stopped, []);
  t.mock.timers.tick(1);
  assert.equal(stopped.length, 1);
  assert.match(stopped[0]!, /timed out.*2 session/);
});

test('a second signal cuts unfinished work immediately and retires the timer', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const stopped: string[] = [];
  const busy = t.mock.fn(() => 3);
  const drain = createDrainController({ busy, stop: (reason) => stopped.push(reason) });
  drain.signal('SIGTERM');
  t.mock.timers.tick(1000);
  assert.deepEqual(stopped, []);
  drain.signal('SIGINT');
  assert.equal(stopped.length, 1);
  assert.match(stopped[0]!, /SIGINT again.*3 session/);
  const reads = busy.mock.callCount();
  drain.signal('SIGINT');
  t.mock.timers.tick(25 * 60_000);
  assert.equal(stopped.length, 1);
  assert.equal(busy.mock.callCount(), reads, 'forced completion retires the polling timer');
});
