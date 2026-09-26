import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoppedWorkNotice } from '@shared/protocol';
import { shouldChime, stoppedWorkChime } from './chime';

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

const stopped: StoppedWorkNotice = {
  id: 'incident-1', sessionId: 'session-1', reason: 'engine_exit', detectedAt: 1000, lastActiveAt: 900,
};

test('a stopped-work incident chimes once across replay, conversation changes, and reload', () => {
  const saved = new Map<string, string>();
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); },
  };
  const consume = stoppedWorkChime(storage);
  assert.equal(consume([stopped], true), true);
  assert.equal(consume([stopped], true), false, 'live notification followed by replay');
  assert.equal(consume([], true), false, 'another conversation');
  assert.equal(consume([stopped], true), false, 'back to the stopped conversation');
  assert.equal(stoppedWorkChime(storage)([stopped], true), false, 'the same tab reloaded');
  assert.equal(consume([stopped, { ...stopped, id: 'incident-2' }], true), true, 'a later interruption');
});

test('muted incidents stay consumed when the bell is enabled later', () => {
  const consume = stoppedWorkChime();
  assert.equal(consume([stopped], false), false);
  assert.equal(consume([stopped], true), false);
  assert.equal(consume([{ ...stopped, id: 'new' }], true), true);
});

test('blocked browser storage still deduplicates incidents in memory', () => {
  const consume = stoppedWorkChime({
    getItem: () => { throw new Error('storage blocked'); },
    setItem: () => { throw new Error('storage blocked'); },
  });
  assert.equal(consume([stopped], true), true);
  assert.equal(consume([stopped], true), false);
});
