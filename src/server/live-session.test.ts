import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engineEnv } from './live-session.js';

test('the engine env never carries the service secrets', () => {
  process.env.AGENT_AUTH_SECRET = 'top-secret';
  process.env.SOME_TOKEN = 'x';
  process.env.BUILDABLE_URL = 'https://app.buildable.to';
  const env = engineEnv({ BUILDABLE_ACCOUNT: 'u1' });
  assert.equal(env.AGENT_AUTH_SECRET, undefined);
  assert.equal(env.SOME_TOKEN, undefined);
  assert.equal(env.BUILDABLE_URL, 'https://app.buildable.to');
  assert.equal(env.BUILDABLE_ACCOUNT, 'u1');
  assert.ok(env.PATH);
});
