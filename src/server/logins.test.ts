import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LoginError, Logins, SERVER_LOGIN } from './logins.js';

const CODE = 'sk-ant-oat01-' + 'a'.repeat(40) + 'WXYZ';
const fresh = () => join(mkdtempSync(join(tmpdir(), 'logins-')), 'logins.json');

test('with nothing saved the chats run on the server login and get no code', () => {
  const l = new Logins(fresh());
  assert.deepEqual(l.current(), { id: SERVER_LOGIN, env: {} });
  assert.deepEqual(l.list().map((r) => [r.id, r.active]), [[SERVER_LOGIN, true]]);
});

test('a login added and picked is what new chats run on; the list never shows the code', () => {
  const file = fresh();
  const l = new Logins(file);
  const row = l.add('nika@buildable.to', CODE);
  assert.equal(row.tail, 'WXYZ');
  assert.ok(!JSON.stringify(l.list()).includes(CODE));
  l.use(row.id);
  assert.deepEqual(l.current(), { id: row.id, env: { CLAUDE_CODE_OAUTH_TOKEN: CODE } });
  // kept across a restart, readable only by the service's user
  assert.equal(new Logins(file).current().id, row.id);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('a wrong code, a blank name, a duplicate and an unknown id are refused as LoginError', () => {
  const l = new Logins(fresh());
  assert.throws(() => l.add('x', 'not-a-code'), LoginError);
  assert.throws(() => l.add(' ', CODE), LoginError);
  l.add('a', CODE);
  assert.throws(() => l.add('b', CODE), LoginError);
  assert.throws(() => l.use('nope'), LoginError);
  assert.throws(() => l.remove(SERVER_LOGIN), LoginError);
});

test('removing the active login falls back to the server login', () => {
  const l = new Logins(fresh());
  const row = l.add('a', CODE);
  l.use(row.id);
  l.remove(row.id);
  assert.equal(l.current().id, SERVER_LOGIN);
});

test('a limit the engine reports is shown on that login, reset time in ms', () => {
  const file = fresh();
  const l = new Logins(file);
  const row = l.add('a', CODE);
  l.noteLimit(row.id, { status: 'rejected', resetsAt: 1_800_000_000, rateLimitType: 'five_hour' });
  const shown = l.list().find((r) => r.id === row.id)?.limit;
  assert.equal(shown?.status, 'rejected');
  assert.equal(shown?.resetsAt, 1_800_000_000_000);
  assert.equal(shown?.type, 'five_hour');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).limits[row.id].status, 'rejected');
  // a login removed meanwhile is not brought back by a late event
  l.remove(row.id);
  l.noteLimit(row.id, { status: 'allowed' });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).limits[row.id], undefined);
});

test("the server login is named by the box's own Claude login email", () => {
  const file = fresh();
  const json = join(file, '..', 'claude.json');
  writeFileSync(json, JSON.stringify({ oauthAccount: { emailAddress: 'oto@buildable.to' } }));
  assert.equal(new Logins(file, json).list()[0]?.name, 'oto@buildable.to');
  assert.equal(new Logins(file, join(file, '..', 'none.json')).list()[0]?.name, 'Saved on the server');
});
