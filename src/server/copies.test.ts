import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Copies } from './copies.js';

function folder(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'copies-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('without a folder there is one copy and it owns every account', () => {
  const only = new Copies({ port: 3456 });
  assert.equal(only.enabled, false);
  assert.equal(only.claim('acme'), 3456);
  assert.equal(only.ownerOf('acme'), 3456);
  assert.deepEqual(only.others(), []);
});

test('an account belongs to the first copy that takes it, until that copy lets it go', (t) => {
  const dir = folder(t);
  const alive = new Set([1, 2]);
  const old = new Copies({ dir, port: 3456, pid: 1, alive: (pid) => alive.has(pid) });
  const fresh = new Copies({ dir, port: 3457, pid: 2, alive: (pid) => alive.has(pid) });
  assert.equal(old.claim('acme'), 3456);
  assert.equal(fresh.claim('acme'), 3456, 'the new copy is told who has it');
  assert.equal(fresh.ownerOf('acme'), 3456);
  assert.deepEqual(fresh.others().map((c) => c.port), [3456]);
  old.release('acme');
  assert.equal(fresh.ownerOf('acme'), null);
  assert.equal(fresh.claim('acme'), 3457);
  fresh.release('other'); // not its own: nothing happens
  old.release('acme'); // no longer its own: the new owner keeps it
  assert.equal(old.ownerOf('acme'), 3457);
});

test('a retiring copy keeps what it has and takes nothing new', (t) => {
  const dir = folder(t);
  const old = new Copies({ dir, port: 3456, pid: 1, alive: () => true });
  assert.equal(old.claim('busy'), 3456);
  old.retire();
  assert.equal(old.retiring, true);
  assert.equal(old.claim('busy'), 3456);
  assert.equal(old.claim('newcomer'), null);
  const fresh = new Copies({ dir, port: 3457, pid: 2, alive: () => true });
  assert.equal(fresh.others()[0]?.retiring, true);
  assert.equal(fresh.claim('newcomer'), 3457);
});

test('what a dead copy held is orphaned and the live copy takes it over', (t) => {
  const dir = folder(t);
  const alive = new Set([1, 2]);
  const old = new Copies({ dir, port: 3456, pid: 1, alive: (pid) => alive.has(pid) });
  const fresh = new Copies({ dir, port: 3457, pid: 2, alive: (pid) => alive.has(pid) });
  old.claim('acme');
  assert.deepEqual(fresh.orphaned(), []);
  alive.delete(1);
  assert.equal(fresh.ownerOf('acme'), null);
  assert.deepEqual(fresh.orphaned(), ['acme']);
  assert.equal(fresh.claim('acme'), 3457);
  assert.deepEqual(fresh.orphaned(), []);
  assert.deepEqual(fresh.others(), [], 'the dead copy is forgotten');
  assert.deepEqual(fresh.owned(), ['acme']);
});

test('a copy that leaves cleanly removes its record', (t) => {
  const dir = folder(t);
  const copy = new Copies({ dir, port: 3456, pid: 1, alive: () => true });
  copy.claim('a');
  copy.claim('b');
  copy.leave();
  assert.deepEqual(readdirSync(dir), []);
});

test('a copy that died while retiring knows it when its slot starts again', (t) => {
  const dir = folder(t);
  const first = new Copies({ dir, port: 3456, pid: 1, alive: () => false });
  first.claim('acme');
  first.retire();
  const again = new Copies({ dir, port: 3456, pid: 9, alive: () => false });
  assert.equal(again.diedRetiring, true);
  again.leave();
  assert.deepEqual(readdirSync(dir), []);
  const clean = new Copies({ dir, port: 3456, pid: 10, alive: () => false });
  assert.equal(clean.diedRetiring, false);
});

test('a copy ended with work open leaves its accounts to be continued, on any port', (t) => {
  const dir = folder(t);
  const alive = new Set([1, 2]);
  const ended = new Copies({ dir, port: 3458, pid: 1, alive: (pid) => alive.has(pid) });
  ended.claim('acme');
  ended.retire();
  ended.forget();
  alive.delete(1);
  // the copy that serves, on another port, sees an account nobody holds
  const serving = new Copies({ dir, port: 3457, pid: 2, alive: (pid) => alive.has(pid) });
  assert.deepEqual(serving.orphaned(), ['acme']);
  // a new copy started in the ended copy's slot is a fresh copy and holds the account
  const sameSlot = new Copies({ dir, port: 3458, pid: 3, alive: () => true });
  assert.equal(sameSlot.diedRetiring, false);
  assert.equal(sameSlot.claim('acme'), 3458);
});
