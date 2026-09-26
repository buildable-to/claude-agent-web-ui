import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionManager } from './session-manager.js';
import { LiveSession } from './live-session.js';

test('deploy drain waits for builders after the coordinator turn ends', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-drain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = new SessionManager(dir);
  // Substitute the process boundary only. The drain calls this manager's
  // actual busy() and reads the SDK's current background-work level.
  const session = Object.assign(Object.create(LiveSession.prototype), {
    status: 'idle', backgroundWork: 6,
  });
  t.mock.method(manager, 'liveSessions', () => [session]);
  assert.equal(manager.busy(), 1, 'an idle coordinator with six builders is still busy');
  session.backgroundWork = 0;
  assert.equal(manager.busy(), 0, 'settled builders release the drain');
  session.status = 'running';
  assert.equal(manager.busy(), 1, 'foreground work still holds the drain');
});
