import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareMarks,
  insertMention,
  linkMarks,
  matchMentions,
  mentionItems,
  mentionLabel,
  mentionQuery,
  splitMentions,
  type Mentions,
} from './mentions';

const M: Mentions = {
  project: 'p1',
  marks: [
    { mark: 'C10', element: { id: 'e3', name: 'Tall column', kind: 'column' }, count: 2, ids: ['o9', 'o10'] },
    { mark: 'C1', element: { id: 'e1', name: 'Corbel column 600×600', kind: 'column' }, count: 8, ids: ['o1'] },
    { mark: 'B1', element: { id: 'e2', name: 'Gutter beam', kind: 'beam' }, count: 1, ids: ['o5'] },
  ],
  library: [{ id: 'fc7b86b4', name: 'Purlin 250×350', kind: 'roof_beam' }],
};

test('the list is marks in natural order, then the library; an element inserts its id', () => {
  const items = mentionItems(M);
  assert.deepEqual(
    items.map((i) => i.label),
    ['B1', 'C1', 'C10', 'Purlin 250×350'],
  );
  assert.equal(items[1]!.hint, 'Corbel column 600×600 · 8 pieces');
  assert.equal(items[3]!.insert, 'fc7b86b4');
  assert.ok(compareMarks('C2', 'C10') < 0);
});

test('typing narrows by mark first, then by name, then by the hint', () => {
  const items = mentionItems(M);
  assert.deepEqual(matchMentions(items, 'c1').map((i) => i.label), ['C1', 'C10']);
  assert.deepEqual(matchMentions(items, 'gutter').map((i) => i.label), ['B1']);
  assert.deepEqual(matchMentions(items, '').length, 4);
});

test('the "@word" at the caret is found, and only there', () => {
  assert.deepEqual(mentionQuery('make @c', 7), { start: 5, query: 'c' });
  assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' });
  assert.equal(mentionQuery('mail me@home', 12), null); // not a word start
  assert.equal(mentionQuery('@C1 is fine', 11), null); // caret past the word
  assert.deepEqual(mentionQuery('@C1 and @B', 10), { start: 8, query: 'B' });
});

test('a pick replaces the word, adds a space, and says where the caret goes', () => {
  const r = insertMention('check @c please', 8, { start: 6 }, 'C1');
  assert.equal(r.value, 'check @C1 please');
  assert.equal(r.caret, 10);
  const end = insertMention('@', 1, { start: 0 }, 'B1');
  assert.deepEqual(end, { value: '@B1 ', caret: 4 });
});

test('the engineer bubble splits words from mentions; a pill wears the name', () => {
  assert.deepEqual(splitMentions('make @C1 deeper, check @fc7b86b4'), [
    'make ',
    { mention: 'C1' },
    ' deeper, check ',
    { mention: 'fc7b86b4' },
  ]);
  assert.deepEqual(mentionLabel('c1', M), {
    label: 'C1',
    title: 'Corbel column 600×600 · 8 pieces — click to light them up',
    mark: 'C1',
  });
  assert.equal(mentionLabel('fc7b86b4', M).label, 'Purlin 250×350');
  assert.equal(mentionLabel('Z9', M).mark, null);
});

test("marks in the agent's words become pills — whole words, never inside code or links", () => {
  const md = 'Set **C1** and C10 deeper; @B1 too.\n`C1` stays, [C1](http://x) stays.\n```\nC1 in code\n```\nC1x is not C1.';
  const out = linkMarks(md, ['C1', 'C10', 'B1']);
  assert.ok(out.includes('**[C1](mention:C1)**'));
  assert.ok(out.includes('[C10](mention:C10) deeper'));
  assert.ok(out.includes('[B1](mention:B1) too'));
  assert.ok(out.includes('`C1` stays, [C1](http://x) stays.'));
  assert.ok(out.includes('\nC1 in code\n'));
  assert.ok(out.includes('C1x is not [C1](mention:C1).'));
});
