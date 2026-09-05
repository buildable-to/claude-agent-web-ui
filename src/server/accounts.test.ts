// The contract with the app, checked without a browser or an engine:
//   node --import tsx --test src/server/*.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Accounts, AuthError, signToken, verifyToken } from './accounts.js';

const SECRET = 'test-secret';
const now = () => Math.floor(Date.now() / 1000);

test('a token the app signs is accepted and its claims come back', () => {
  const t = signToken({ sub: '80f4a12e', email: 'test@buildable.to', sid: 'd8344502', exp: now() + 60 }, SECRET);
  const c = verifyToken(t, SECRET);
  assert.equal(c.sub, '80f4a12e');
  assert.equal(c.sid, 'd8344502');
});

test('every defect is an AuthError (401), never a plain error (500)', () => {
  const good = signToken({ sub: 'a', exp: now() + 60 }, SECRET);
  const cases: Array<[string, string]> = [
    ['malformed', 'a.b'],
    ['garbage', 'x.y.z'],
    ['wrong secret', signToken({ sub: 'a', exp: now() + 60 }, 'other')],
    ['expired', signToken({ sub: 'a', exp: now() - 1 }, SECRET)],
    ['no exp', signToken({ sub: 'a' }, SECRET)],
    ['no subject', signToken({ sub: '', exp: now() + 60 }, SECRET)],
    ['tampered', `${good.split('.')[0]}.${good.split('.')[1]}x.${good.split('.')[2]}`],
  ];
  for (const [name, token] of cases) {
    assert.throws(() => verifyToken(token, SECRET), AuthError, name);
  }
});

test('an account folder is made on first use, from the template, and marked trusted', () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-'));
  const tpl = join(root, 'tpl.json');
  writeFileSync(tpl, JSON.stringify({ permissions: { allow: ['Edit(/scratch/**)'] } }));
  const claudeJson = join(root, 'claude.json');
  const accounts = new Accounts({ root, authSecret: SECRET, settingsTemplate: tpl, claudeConfigPath: claudeJson });
  const a = accounts.resolve(signToken({ sub: 'u1', sid: 'p1', exp: now() + 60 }, SECRET), undefined);
  assert.equal(a.id, 'u1');
  assert.equal(a.project, 'p1');
  assert.ok(existsSync(join(a.dir, 'scratch')));
  assert.deepEqual(JSON.parse(readFileSync(join(a.dir, '.claude', 'settings.json'), 'utf8')), {
    permissions: { allow: ['Edit(/scratch/**)'] },
  });
  const cfg = JSON.parse(readFileSync(claudeJson, 'utf8')) as { projects: Record<string, { hasTrustDialogAccepted: boolean }> };
  assert.equal(cfg.projects[a.dir]?.hasTrustDialogAccepted, true);
});

test('without a token there is no account; a bad id is refused; a missing template is fatal', () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-'));
  const accounts = new Accounts({ root, authSecret: SECRET, claudeConfigPath: join(root, 'claude.json') });
  assert.throws(() => accounts.resolve(undefined, undefined), AuthError);
  assert.throws(() => accounts.resolve(signToken({ sub: '../etc', exp: now() + 60 }, SECRET), undefined), AuthError);
  assert.throws(
    () => new Accounts({ root, authSecret: SECRET, settingsTemplate: join(root, 'missing.json'), claudeConfigPath: join(root, 'c.json') }),
    /template not found/,
  );
});

test('dev mode picks the folder from ?account= only when there is no secret', () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-'));
  const dev = new Accounts({ root, authSecret: '', claudeConfigPath: join(root, 'claude.json') });
  assert.equal(dev.resolve(undefined, 'luka').id, 'luka');
  const prod = new Accounts({ root, authSecret: SECRET, claudeConfigPath: join(root, 'claude.json') });
  assert.throws(() => prod.resolve(undefined, 'luka'), AuthError);
});
