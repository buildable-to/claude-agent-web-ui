import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readScope, type Store } from './scope';

// One tab holds Project Studio and Element Studio frames on the same origin,
// so they share sessionStorage. The library frame must never take the
// project a project frame left there, and a project frame must never be
// turned into a library one by what the library frame left.

function memory(seed: Record<string, string> = {}): Store & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

test('a library frame never falls back to the project remembered in the tab', () => {
  const store = memory({ 'page:project': 'p1' });
  assert.deepEqual(readScope('?embed=1&project=&scope=library&token=t', store), { scope: 'library', project: null });
  assert.deepEqual(readScope('?embed=1&scope=library&token=t', store), { scope: 'library', project: null });
});

test('an explicit empty project= means none, not the remembered one', () => {
  const store = memory({ 'page:project': 'p1' });
  assert.deepEqual(readScope('?embed=1&project=&token=t', store), { scope: null, project: null });
  assert.equal(store.data['page:project'], 'p1', 'nothing is overwritten either');
});

test('a project frame keeps its project, and a reload without it still knows it', () => {
  const store = memory();
  assert.deepEqual(readScope('?embed=1&project=p2&token=t', store), { scope: null, project: 'p2' });
  assert.deepEqual(readScope('', store), { scope: null, project: 'p2' });
});

test('the scope is the URL’s alone: a remembered library never sticks to another frame', () => {
  const store = memory({ 'page:scope': 'library' });
  assert.deepEqual(readScope('?embed=1&project=p2', store), { scope: null, project: 'p2' });
  assert.deepEqual(readScope('?scope=other&project=p2', store), { scope: null, project: 'p2' });
});

test('no storage at all (blocked) reads as nothing remembered', () => {
  assert.deepEqual(readScope('', null), { scope: null, project: null });
});
