import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkViews, readViewing, splitViewing, withViewing } from './studio';

// A `viewing` record comes off a postMessage from Project Studio. It is shown
// to the engineer as a chip and it goes out in front of what they type, so a
// malformed one would print an empty chip, or a bare "Looking at" — or a
// stranger's shape — into the agent's prompt.

const good = {
  source: 'buildable-studio',
  type: 'viewing',
  project: 'nika30x15',
  mode: 'drawings',
  mark: 'E1',
  element: { id: 'e1', name: 'Double-slope roof beam 500', kind: 'beam' },
  sheet: { kind: 'bands', label: 'Reinforcement' },
  page: { n: 1, of: 4 },
  view: { key: 'viewA', caption: 'VIEW FROM A', denom: 12 },
  text: 'E1 · Reinforcement · page 1 of 4 · VIEW FROM A',
  line: 'Looking at E1 · Reinforcement · page 1 of 4 · VIEW FROM A [viewA]',
};

test('reads what the studio shows', () => {
  assert.deepEqual(readViewing(good), {
    mode: 'drawings',
    text: 'E1 · Reinforcement · page 1 of 4 · VIEW FROM A',
    line: 'Looking at E1 · Reinforcement · page 1 of 4 · VIEW FROM A [viewA]',
    mark: 'E1',
    element: { id: 'e1', name: 'Double-slope roof beam 500', kind: 'beam' },
    sheet: { kind: 'bands', label: 'Reinforcement' },
    page: { n: 1, of: 4 },
    view: { key: 'viewA', caption: 'VIEW FROM A', denom: 12 },
  });
});

test('refuses anything that is not a viewing record', () => {
  assert.equal(readViewing({ ...good, type: 'mentions' }), null);
  assert.equal(readViewing({ ...good, type: 'mention' }), null);
});

test('refuses a record with no words — it would print an empty chip', () => {
  assert.equal(readViewing({ ...good, text: '' }), null);
  assert.equal(readViewing({ ...good, text: 7 }), null);
  assert.equal(readViewing({ ...good, line: 'E1' }), null); // not context, a bare name
});

test('the whole project in 3D is the smallest record there is', () => {
  const v = readViewing({
    source: 'buildable-studio',
    type: 'viewing',
    mode: '3d',
    text: 'the whole project in 3D',
    line: 'Looking at the whole project in 3D',
  });
  assert.deepEqual(v, { mode: '3d', text: 'the whole project in 3D', line: 'Looking at the whole project in 3D' });
});

test('an unknown mode reads as 3D, a view with no caption is named by its key', () => {
  const v = readViewing({ ...good, mode: 'cinema', view: { key: 'elev' } });
  assert.equal(v?.mode, '3d');
  assert.deepEqual(v?.view, { key: 'elev', caption: 'elev', denom: null });
});

test('the line rides in front of the message, and folds back off it in the transcript', () => {
  const v = readViewing(good)!;
  const sent = withViewing('make this 25% bigger', v);
  assert.equal(sent, `${good.line}\nmake this 25% bigger`);
  assert.deepEqual(splitViewing(sent), { viewing: good.line, text: 'make this 25% bigger' });
});

test('a message with no context goes out and comes back whole', () => {
  assert.equal(withViewing('hi', null), 'hi');
  assert.deepEqual(splitViewing('hi'), { viewing: null, text: 'hi' });
  // an engineer who happens to START a sentence with the words is not folded
  assert.deepEqual(splitViewing('Looking at it now, seems fine'), {
    viewing: null,
    text: 'Looking at it now, seems fine',
  });
});

// Views the agent names become pills — only the open sheet's, as printed.
const VIEWS = [
  { key: 'elev', caption: 'ELEVATION', denom: 75 },
  { key: 'viewA', caption: 'VIEW FROM A', denom: 12 },
  { key: 'sec@2305', caption: 'SECTION B–B', denom: 10 },
];

test('a caption of the open sheet becomes a pill carrying the view key', () => {
  assert.equal(
    linkViews('I moved VIEW FROM A to 1:10 and left the ELEVATION alone.', VIEWS),
    'I moved [VIEW FROM A](view:viewA) to 1:10 and left the [ELEVATION](view:elev) alone.',
  );
});

test('a caption inside code or an existing link is left alone, and case must match the paper', () => {
  assert.equal(
    linkViews('`VIEW FROM A` stays; [VIEW FROM A](view:viewA) stays', VIEWS),
    '`VIEW FROM A` stays; [VIEW FROM A](view:viewA) stays',
  );
  assert.equal(linkViews('the view from a is small', VIEWS), 'the view from a is small');
});

test('a longer caption wins over one it contains', () => {
  const views = [
    { key: 'plan', caption: 'Plan', denom: 50 },
    { key: 'pend', caption: 'Plan (end)', denom: 50 },
  ];
  assert.equal(linkViews('see Plan (end)', views), 'see [Plan (end)](view:pend)');
});

test('no views, no change', () => {
  assert.equal(linkViews('VIEW FROM A', []), 'VIEW FROM A');
});
