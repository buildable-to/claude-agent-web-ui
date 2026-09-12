import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionTitle, titleFromPrompt } from './session-manager.js';

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
