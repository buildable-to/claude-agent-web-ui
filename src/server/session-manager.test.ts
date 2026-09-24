import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionTitle, shouldReap, titleFromPrompt } from './session-manager.js';

test("a conversation's title: the engineer's name for it, else the summary, else how it began", () => {
  assert.equal(sessionTitle({ customTitle: 'Gutters', summary: 'Making gutters', firstPrompt: 'make the gutter' }), 'Gutters');
  assert.equal(sessionTitle({ summary: 'Making gutters', firstPrompt: 'make the gutter' }), 'Making gutters');
  assert.equal(sessionTitle({ firstPrompt: 'make the gutter' }), 'make the gutter');
  assert.equal(sessionTitle({ customTitle: '' }), undefined);
});

test('a fresh conversation is called by the first line of its first message, cut short', () => {
  assert.equal(titleFromPrompt('make the gutter GT-1 from gutter.dxf\nlength as drawn'), 'make the gutter GT-1 from gutter.dxf');
  assert.equal(titleFromPrompt('\n\n   spaced   out  \n'), 'spaced out');
  // the chip's line is context, not the name (found live: "Looking at the whole project in 3D")
  assert.equal(titleFromPrompt('Looking at the whole project in 3D\nMake a simple precast lintel for this project'), 'Make a simple precast lintel for this project');
  assert.equal(titleFromPrompt('Looking at E1 · Reinforcement [viewA]'), undefined);
  assert.equal(titleFromPrompt(''), undefined);
  assert.equal(titleFromPrompt(undefined), undefined);
  const long = 'x'.repeat(200);
  const cut = titleFromPrompt(long)!;
  assert.equal(cut.length, 120);
  assert.ok(cut.endsWith('…'));
});

test('a conversation whose sub-agents still work is not reaped as idle', () => {
  const now = 10 * 60 * 60 * 1000;
  const hours = (h: number) => now - h * 60 * 60 * 1000;
  // the turn ended, nothing running: an hour of quiet closes it
  assert.equal(shouldReap({ status: 'idle', lastActivity: hours(1.1), backgroundWork: 0 }, now), true);
  assert.equal(shouldReap({ status: 'idle', lastActivity: hours(0.5), backgroundWork: 0 }, now), false);
  // six drafters at work two hours after the turn ended (Maxima, 2026-09-24): kept
  assert.equal(shouldReap({ status: 'idle', lastActivity: hours(2), backgroundWork: 6 }, now), false);
  // …unless nothing at all was heard for six hours: a task that never settles
  assert.equal(shouldReap({ status: 'idle', lastActivity: hours(6.5), backgroundWork: 6 }, now), true);
  // a turn in flight is never reaped
  assert.equal(shouldReap({ status: 'running', lastActivity: hours(9), backgroundWork: 0 }, now), false);
});
