import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KNOWN_KEEP, rememberKnown } from './known';

test('only the main conversation counts, newest last, at most KNOWN_KEEP', () => {
  const known = rememberKnown(['old'], [
    { type: 'assistant', uuid: 'a1', parent_tool_use_id: null },
    { type: 'assistant', uuid: 'h1', parent_tool_use_id: 'agent' },
    { type: 'system', uuid: 'n1' },
    { type: 'user', uuid: 'u1' },
    { type: 'result' },
  ]);
  assert.deepEqual(known, ['old', 'a1', 'u1']);
  const many = rememberKnown([], Array.from({ length: KNOWN_KEEP + 10 }, (_, i) => ({ type: 'assistant', uuid: `a${i}` })));
  assert.equal(many.length, KNOWN_KEEP);
  assert.equal(many.at(-1), `a${KNOWN_KEEP + 9}`);
});
