import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldChime } from './chime';

test('a card that comes up during a live turn chimes', () => {
  assert.equal(shouldChime('running', 'requires_action'), true);
  assert.equal(shouldChime('starting', 'requires_action'), true);
});

test('a card found on arrival is not news', () => {
  // the page opened, or a conversation was picked: attach replays the card
  assert.equal(shouldChime('connecting', 'requires_action'), false);
  assert.equal(shouldChime('idle', 'requires_action'), false);
});

test('a second card queued behind the first does not sound again', () => {
  assert.equal(shouldChime('requires_action', 'requires_action'), false);
});

test('no other change sounds', () => {
  assert.equal(shouldChime('idle', 'starting'), false);
  assert.equal(shouldChime('starting', 'running'), false);
  assert.equal(shouldChime('requires_action', 'running'), false);
  assert.equal(shouldChime('running', 'idle'), false);
  assert.equal(shouldChime('running', 'closed'), false);
});
