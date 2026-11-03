import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saidAtLabel } from './saidAt';

test('a message from today shows its time only; another day adds the date, another year the year', () => {
  const now = new Date(2026, 10, 3, 18, 30).getTime();
  const today = saidAtLabel(new Date(2026, 10, 3, 14, 5).getTime(), now);
  assert.match(today, /14.05|2.05/);
  assert.doesNotMatch(today, /Nov/);
  const earlier = saidAtLabel(new Date(2026, 10, 1, 9, 0).getTime(), now);
  assert.match(earlier, /Nov/);
  assert.doesNotMatch(earlier, /2026/);
  assert.match(saidAtLabel(new Date(2025, 10, 1, 9, 0).getTime(), now), /2025/);
});
