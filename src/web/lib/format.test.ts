import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clock } from './format';

test('the work line clock reads like a stopwatch', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(7_900), '0:07');
  assert.equal(clock(12 * 60_000 + 40_000), '12:40');
  assert.equal(clock(3_789_000), '1:03:09');
  assert.equal(clock(-500), '0:00');
});
