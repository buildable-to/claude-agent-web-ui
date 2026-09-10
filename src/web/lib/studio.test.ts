import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTag } from './studio';

// A tag comes off a postMessage from Project Studio. It is shown to the
// engineer and it goes out in front of what they type, so a malformed one
// would put a bare "@" — or a stranger's shape — into the agent's prompt.

const good = {
  source: 'buildable-studio',
  type: 'mention',
  project: 'nika30x15',
  mark: 'C3',
  element: { id: 'e1', name: 'Fachwerk column 410×400', kind: 'column' },
  count: 3,
  ids: ['o1', 'o2', 'o3'],
};

test('reads a piece the studio picked', () => {
  assert.deepEqual(readTag(good), {
    mark: 'C3',
    element: { id: 'e1', name: 'Fachwerk column 410×400', kind: 'column' },
    count: 3,
    ids: ['o1', 'o2', 'o3'],
  });
});

test('refuses anything that is not a mention', () => {
  assert.equal(readTag({ ...good, type: 'mentions' }), null);
});

test('refuses a tag with no mark — it would render as a bare @', () => {
  assert.equal(readTag({ ...good, mark: '' }), null);
  assert.equal(readTag({ ...good, mark: 7 }), null);
  const { mark: _mark, ...noMark } = good;
  assert.equal(readTag(noMark), null);
});

test('survives a tag with no element or counts — the mark is what matters', () => {
  assert.deepEqual(readTag({ source: 'buildable-studio', type: 'mention', mark: 'B1' }), {
    mark: 'B1',
    element: { id: '', name: '', kind: '' },
    count: 0,
    ids: [],
  });
});

test('keeps only the string ids', () => {
  assert.deepEqual(readTag({ ...good, ids: ['o1', 3, null, 'o2'] })?.ids, ['o1', 'o2']);
  assert.deepEqual(readTag({ ...good, ids: 'o1' })?.ids, []);
});
