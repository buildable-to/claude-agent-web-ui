import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engineEnv, focusFromResult, perceiveTarget } from './live-session.js';

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

// The Element tab in Project Studio follows what the agent reads or saves:
// the server watches the element door's command lines and results.

test('a perceive names its element or draft, flags and paths notwithstanding', () => {
  assert.deepEqual(perceiveTarget('python -m buildable.services.perceive_v4 9c1e4f2a --menu'), { id: '9c1e4f2a', save: false });
  assert.deepEqual(perceiveTarget('perceive_v4 d4f2 --save --real --email o@x'), { id: 'd4f2', save: true });
  assert.deepEqual(perceiveTarget('cd /srv && python -m buildable.services.perceive_v4 el1 --apply ops.json --real'), { id: 'el1', save: false });
  assert.equal(perceiveTarget('perceive_v4 --apply-many batches.json --real'), null, 'no id in front of the flags');
  assert.equal(perceiveTarget('perceive_project_v4 abc123'), null, 'the project door is not the element door');
});

test('after a save the tab looks at the saved element; a draft read stays a draft; a plain read lets the page decide', () => {
  assert.deepEqual(focusFromResult({ id: 'd4f2', save: true }, 'save: d4f2 → SAVED as 9c1e “Column C3”\n  knobs: length'), { id: '9c1e', kind: 'element' });
  assert.deepEqual(focusFromResult({ id: 'd4f2', save: true }, 'save: d4f2 → UPDATED e4 “Column C3” v8'), { id: 'e4', kind: 'element' });
  assert.deepEqual(focusFromResult({ id: 'd4f2', save: true }, 'save: d4f2 → would land (scratch — add --real to save it): “Column C3”'), { id: 'd4f2', kind: 'draft' });
  assert.deepEqual(focusFromResult({ id: '9c1e', save: false }, 'element 9c1e · v7 …'), { id: '9c1e' });
});
