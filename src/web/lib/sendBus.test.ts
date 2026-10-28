import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerElement, answerOf, knowElement, onAnswers, sendText, setSender } from './sendBus';

test('an element answer is sent as words and remembered for every card of it', () => {
  const sent: string[] = [];
  setSender((t) => sent.push(t));
  let heard = 0;
  const off = onAnswers(() => heard++);
  knowElement('508a662b', 'Column 600 × 600 × 15830');
  knowElement('508a662b', 'a later title does not replace the first');
  assert.equal(answerElement('508a662b', 'use'), true);
  assert.deepEqual(sent, ['Use Column 600 × 600 × 15830 (element 508a662b).']);
  assert.equal(answerOf('508a662b'), 'use');
  assert.equal(heard, 1);
  off();
  setSender(null);
});

test('without a chat box nothing is sent and nothing is marked', () => {
  setSender(null);
  assert.equal(sendText('hello'), false);
  assert.equal(answerElement('e2', 'use'), false);
  assert.equal(answerOf('e2'), undefined);
});
