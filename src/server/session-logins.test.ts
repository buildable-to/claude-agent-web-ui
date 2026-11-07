// The admin's picked Claude login reaches the engine, and a limit the engine
// reports lands on that login. Only the CLI process is faked.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { Query, SDKMessage, query } from '@anthropic-ai/claude-agent-sdk';

const root = mkdtempSync(join(tmpdir(), 'session-logins-'));
process.env.CLAUDE_CONFIG_DIR = join(root, 'home');
process.env.CLAUDE_LOGINS_FILE = join(root, 'logins.json');
mkdirSync(join(root, 'acct'));

const { SessionManager } = await import('./session-manager.js');
const { sharedLogins } = await import('./logins.js');

function engine() {
  const envs: Array<Record<string, string | undefined>> = [];
  const queues: Array<{ push(m: SDKMessage | null): void }> = [];
  const factory: typeof query = (args) => {
    envs.push(args.options?.env ?? {});
    const messages: Array<SDKMessage | null> = [];
    let wake: (() => void) | undefined;
    const q = { push(m: SDKMessage | null) { messages.push(m); wake?.(); } };
    queues.push(q);
    args.options?.abortController?.signal.addEventListener('abort', () => q.push(null));
    const stream = (async function* () {
      while (true) {
        if (!messages.length) await new Promise<void>((r) => { wake = r; });
        const v = messages.shift();
        if (v === null || v === undefined) return;
        yield v;
      }
    })();
    return Object.assign(stream, { interrupt: async () => {}, close: () => {} }) as unknown as Query;
  };
  return { factory, envs, queues };
}

test('a new chat runs on the picked login; switching restarts idle chats onto the new one', async () => {
  const code = 'sk-ant-oat01-' + 'b'.repeat(40);
  const e = engine();
  const manager = new SessionManager(join(root, 'acct'), 'acct', undefined, { queryFactory: e.factory });

  // nothing picked: the server's own login, no code passed
  const first = await manager.open(null);
  assert.equal(e.envs[0]?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  e.queues[0]!.push({ type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: 'u1', session_id: 's' } as unknown as SDKMessage);
  await setImmediate();

  const row = sharedLogins().add('second@buildable.to', code);
  sharedLogins().use(row.id);
  assert.equal(manager.closeIdle(), 1);
  assert.equal(first.status, 'closed');

  await manager.open(null);
  assert.equal(e.envs[1]?.CLAUDE_CODE_OAUTH_TOKEN, code);

  // the engine says this login is out: shown on that login's row
  e.queues[1]!.push({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt: 1_800_000_000, rateLimitType: 'five_hour' },
    uuid: 'u2',
    session_id: 's',
  } as unknown as SDKMessage);
  await setImmediate();
  const shown = sharedLogins().list().find((r) => r.id === row.id);
  assert.equal(shown?.limit?.status, 'rejected');
  manager.closeAll();
});
