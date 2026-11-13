// A conversation keeps the model the engineer picked for it when its engine
// stops and comes back. Only the CLI process is faked.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Query, SDKMessage, query } from '@anthropic-ai/claude-agent-sdk';
import { SessionManager } from './session-manager.js';

function engine() {
  const models: Array<string | undefined> = [];
  const factory: typeof query = (args) => {
    models.push(args.options?.model);
    let stop: (() => void) | undefined;
    args.options?.abortController?.signal.addEventListener('abort', () => stop?.());
    const stream = (async function* (): AsyncGenerator<SDKMessage> {
      await new Promise<void>((r) => { stop = r; });
    })();
    return Object.assign(stream, { interrupt: async () => {}, close: () => {}, setModel: async () => {} }) as unknown as Query;
  };
  return { factory, models };
}

test('a conversation comes back on the model picked for it, not on the default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-model-'));
  const e = engine();
  const deps = { queryFactory: e.factory, getSessionInfo: (async () => ({ summary: 'x' })) as never };
  const manager = new SessionManager(dir, undefined, undefined, deps);

  // nothing picked: the engine's default
  const chat = await manager.open(null);
  assert.equal(e.models[0], undefined);
  await chat.setModel('opus');
  chat.close();

  // the engine stopped; the same conversation resumes on what was picked
  const back = await manager.open(chat.sessionId);
  assert.equal(e.models[1], 'opus');
  back.close();

  // also after the service itself restarted
  const later = new SessionManager(dir, undefined, undefined, deps);
  const again = await later.open(chat.sessionId);
  assert.equal(e.models[2], 'opus');

  // back to the default: nothing is pinned any more
  await again.setModel(null);
  again.close();
  (await later.open(chat.sessionId)).close();
  assert.equal(e.models[3], undefined);

  // a model picked before the first message is kept too
  const picked = await manager.open(null, { model: 'sonnet' });
  picked.close();
  (await manager.open(picked.sessionId)).close();
  assert.equal(e.models[5], 'sonnet');
});
