// The two promises of the stamp panel, attacked from the other side:
//  (P1) a stamp token only ever reaches engines that run with
//       BUILDABLE_SCOPE=stamp and no BUILDABLE_PROJECT;
//  (P2) stamp and project conversations never cross panels: not by resume,
//       not by attaching to (or sending to) a RUNNING engine, not over HTTP.
// Each case was a working attack before the one panel check
// (SessionManager.checkPanel) guarded every client-supplied id.
//   node --import tsx --test src/server/*.test.ts
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Query, query } from '@anthropic-ai/claude-agent-sdk';
import express from 'express';
import { WebSocket } from 'ws';
import type { ServerMessage } from '../shared/protocol.js';
import type { Account } from './accounts.js';
import { engineEnv } from './live-session.js';
import { CROSS_PANEL, SessionManager } from './session-manager.js';
import { sessionRoutes } from './session-routes.js';
import { attachWebSocket } from './ws.js';

/** Engines to close before their folder goes (a closing engine writes its journal there). */
const managers = new WeakMap<TestContext, SessionManager[]>();

function folder(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-panel-'));
  managers.set(t, []);
  t.after(() => {
    for (const m of managers.get(t) ?? []) m.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** An engine that never speaks; what it is started with and sent is the test. */
function engine() {
  const launches: Array<Parameters<typeof query>[0]['options']> = [];
  const sent: string[] = [];
  const factory: typeof query = (args) => {
    launches.push(args.options);
    void (async () => {
      for await (const m of args.prompt as AsyncIterable<unknown>) sent.push(JSON.stringify(m));
    })().catch(() => {});
    const stream = (async function* () {
      await new Promise<void>((resolve) => args.options?.abortController?.signal.addEventListener('abort', () => resolve()));
    })();
    return Object.assign(stream, {
      interrupt: async () => { sent.push('<interrupt>'); },
      setModel: async (m: string) => { sent.push(`<model ${m}>`); },
      setPermissionMode: async (m: string) => { sent.push(`<mode ${m}>`); },
      close: () => {},
    }) as unknown as Query;
  };
  return { factory, launches, sent };
}

const info = (id: string) => ({ sessionId: id, lastModified: 1, summary: id, fileSize: 1 });

function manager(t: TestContext, dir: string, cli = engine()) {
  const calls: string[] = [];
  const m = new SessionManager(dir, 'u1', undefined, {
    queryFactory: cli.factory,
    getSessionInfo: async (id) => info(id),
    getSessionMessages: async (id) => {
      calls.push(`history ${id}`);
      return [];
    },
    renameSession: async (id) => { calls.push(`rename ${id}`); },
    deleteSession: async (id) => { calls.push(`delete ${id}`); },
  });
  managers.get(t)?.push(m);
  return { m, cli, calls };
}

const STAMP: Account = { id: 'u1', scope: 'stamp', dir: '' };
const PROJECT: Account = { id: 'u1', project: 'p1', dir: '' };

async function listen(t: TestContext, server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  return addr.port;
}

/** A socket that speaks for `account`; `reply()` waits for the next message. */
async function socket(t: TestContext, m: SessionManager, dir: string, account: Account) {
  const server = createServer();
  const wss = attachWebSocket(server, () => ({ manager: m, dir, account: { ...account, dir } }));
  t.after(() => wss.close());
  const port = await listen(t, server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=x`);
  t.after(() => ws.terminate());
  await new Promise<void>((resolve) => ws.once('open', resolve));
  const reply = () => new Promise<ServerMessage>((resolve) => ws.once('message', (raw) => resolve(JSON.parse(String(raw)))));
  const ask = async (msg: object) => {
    const r = reply();
    ws.send(JSON.stringify(msg));
    return r;
  };
  return { ask };
}

/** Every socket message that takes a session id, aimed at `id`. */
const ID_MESSAGES = (id: string) => [
  { type: 'start', sessionId: id, text: 'from the other panel' },
  { type: 'attach', sessionId: id },
  { type: 'send', sessionId: id, text: 'from the other panel' },
  { type: 'permission', sessionId: id, requestId: 'r', behavior: 'allow' },
  { type: 'interrupt', sessionId: id },
  { type: 'set_model', sessionId: id, model: 'other' },
  { type: 'set_permission_mode', sessionId: id, mode: 'plan' },
];

for (const [name, own, other] of [
  ['a stamp token cannot reach a RUNNING project engine', { project: 'p1' }, STAMP],
  ['a project token cannot reach a RUNNING stamp engine', { scope: 'stamp' as const }, PROJECT],
] as const) {
  test(`${name}: start, attach, send, permission, interrupt, set_model, set_permission_mode`, async (t) => {
    const dir = folder(t);
    const { m, cli } = manager(t, dir);
    const running = await m.open(null, { ...own, firstPrompt: 'mine' });
    const { ask } = await socket(t, m, dir, other);
    for (const msg of ID_MESSAGES(running.sessionId)) {
      const r = await ask(msg);
      assert.equal(r.type, 'error', `${msg.type} -> ${r.type}`);
      assert.equal(r.type === 'error' && r.message, CROSS_PANEL, msg.type);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(cli.sent, [], 'the engine heard nothing from the other panel');
    assert.equal(cli.launches.length, 1, 'no second engine');
  });
}

test('a running engine still answers its own panel', async (t) => {
  const dir = folder(t);
  const { m, cli } = manager(t, dir);
  const s = await m.open(null, { scope: 'stamp', firstPrompt: 'stamp' });
  const { ask } = await socket(t, m, dir, STAMP);
  assert.equal((await ask({ type: 'attach', sessionId: s.sessionId })).type, 'attached');
  assert.equal((await ask({ type: 'start', sessionId: s.sessionId, text: 'again' })).type, 'attached');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(cli.sent.some((x) => x.includes('again')));
});

test('an engine still opening is checked too: the other panel waits, then is refused', async (t) => {
  const dir = folder(t);
  writeFileSync(join(dir, '.agent-scopes.json'), JSON.stringify({ s1: 'stamp' }));
  const { m, cli } = manager(t, dir);
  const mine = m.open('s1', { scope: 'stamp' });
  const theirs = m.open('s1', { project: 'p1' });
  await mine;
  await assert.rejects(theirs, new RegExp(CROSS_PANEL));
  assert.equal(cli.launches.length, 1);
});

/** The conversation routes, mounted as index.ts mounts them. */
async function http(t: TestContext, m: SessionManager, dir: string, account: Account) {
  const app = express();
  app.use('/api', (_req, res, next) => {
    res.locals.ctx = { manager: m, dir, account: { ...account, dir } };
    next();
  });
  app.use('/api', express.json());
  app.use('/api', sessionRoutes());
  const port = await listen(t, createServer(app));
  return (method: string, path: string, body?: object) =>
    fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
}

for (const [name, tags, id, account] of [
  ["a stamp token cannot read, rename or delete a project's conversation", { p: { p1: 'p1' }, s: {} }, 'p1', STAMP],
  ["a project token cannot read, rename or delete /stamp's conversation", { p: {}, s: { s1: 'stamp' } }, 's1', PROJECT],
  ['a stamp token cannot touch an untagged (terminal) conversation', { p: {}, s: {} }, 'u1', STAMP],
] as const) {
  test(`HTTP: ${name} (403)`, async (t) => {
    const dir = folder(t);
    writeFileSync(join(dir, '.agent-projects.json'), JSON.stringify(tags.p));
    writeFileSync(join(dir, '.agent-scopes.json'), JSON.stringify(tags.s));
    const { m, calls } = manager(t, dir);
    const call = await http(t, m, dir, account);
    for (const [method, path, body] of [
      ['GET', `/sessions/${id}/messages`],
      ['PATCH', `/sessions/${id}`, { title: 'mine now' }],
      ['DELETE', `/sessions/${id}`],
    ] as const) {
      const r = await call(method, path, body);
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(((await r.json()) as { error: string }).error, CROSS_PANEL);
    }
    assert.deepEqual(calls, [], 'the store was never touched');
  });
}

test('HTTP: each panel still reads, renames and deletes its own', async (t) => {
  const dir = folder(t);
  writeFileSync(join(dir, '.agent-projects.json'), JSON.stringify({ p1: 'p1' }));
  writeFileSync(join(dir, '.agent-scopes.json'), JSON.stringify({ s1: 'stamp' }));
  const { m, calls } = manager(t, dir);
  for (const [account, id] of [[STAMP, 's1'], [PROJECT, 'p1']] as const) {
    const call = await http(t, m, dir, account);
    assert.equal((await call('GET', `/sessions/${id}/messages`)).status, 200);
    assert.equal((await call('PATCH', `/sessions/${id}`, { title: 'x' })).status, 200);
    assert.equal((await call('DELETE', `/sessions/${id}`)).status, 200);
  }
  assert.deepEqual(calls, ['history s1', 'rename s1', 'delete s1', 'history p1', 'rename p1', 'delete p1']);
});

test('a corrupt .agent-scopes.json fails closed: no panel list, no resume, no new stamp chat; the file is kept', async (t) => {
  const dir = folder(t);
  const corrupt = '{"s1": "stamp",';
  writeFileSync(join(dir, '.agent-scopes.json'), corrupt);
  const cli = engine();
  const m = new SessionManager(dir, 'u1', undefined, {
    queryFactory: cli.factory,
    getSessionInfo: async (id) => info(id),
    listSessions: async () => [info('s1'), info('p1')],
  });
  managers.get(t)?.push(m);
  // before: s1 was listed on a panel with no project and resumed on project q
  await assert.rejects(m.list({}), /tags are unreadable/);
  await assert.rejects(m.list({ project: 'q' }), /tags are unreadable/);
  await assert.rejects(m.list({ scope: 'stamp' }), /tags are unreadable/);
  await assert.rejects(m.open('s1', { project: 'q' }), /tags are unreadable/);
  await assert.rejects(m.open('s1', { scope: 'stamp' }), /tags are unreadable/);
  await assert.rejects(m.open(null, { scope: 'stamp' }), /tags are unreadable/);
  assert.equal(cli.launches.length, 0, 'no engine started');
  // the usage view (every conversation) still works
  assert.deepEqual((await m.list()).map((r) => r.sessionId).sort(), ['p1', 's1']);
  // left for a human, not set aside (a new empty file would make every stamp chat look like a project's)
  assert.equal(readFileSync(join(dir, '.agent-scopes.json'), 'utf8'), corrupt);
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('corrupt')), []);
});

test('a stamp chat whose tag cannot be written is refused and its engine closed', async (t) => {
  const dir = folder(t);
  const { m } = manager(t, dir);
  // the tag file's temp path is taken, so its write (and only its) fails
  mkdirSync(join(dir, `.agent-scopes.json.${process.pid}.tmp`));
  await assert.rejects(m.open(null, { scope: 'stamp', firstPrompt: 'stamp' }), /could not be tagged/);
  assert.deepEqual(m.liveSessions(), [], 'its engine is closed');
  assert.equal(existsSync(join(dir, '.agent-scopes.json')), false);
  assert.deepEqual(await m.list({ scope: 'stamp' }), []);
});

test('engineEnv: an inherited BUILDABLE_PROJECT or BUILDABLE_SCOPE never reaches an engine', (t) => {
  const before = { p: process.env.BUILDABLE_PROJECT, s: process.env.BUILDABLE_SCOPE };
  t.after(() => {
    if (before.p === undefined) delete process.env.BUILDABLE_PROJECT;
    else process.env.BUILDABLE_PROJECT = before.p;
    if (before.s === undefined) delete process.env.BUILDABLE_SCOPE;
    else process.env.BUILDABLE_SCOPE = before.s;
  });
  process.env.BUILDABLE_PROJECT = 'leaked';
  process.env.BUILDABLE_SCOPE = 'stamp';
  const stamp = engineEnv({ BUILDABLE_ACCOUNT: 'u1', BUILDABLE_SCOPE: 'stamp' });
  assert.equal('BUILDABLE_PROJECT' in stamp, false);
  assert.equal(stamp.BUILDABLE_SCOPE, 'stamp');
  const project = engineEnv({ BUILDABLE_ACCOUNT: 'u1', BUILDABLE_PROJECT: 'p1' });
  assert.equal('BUILDABLE_SCOPE' in project, false);
  assert.equal(project.BUILDABLE_PROJECT, 'p1');
  const neither = engineEnv({});
  assert.equal('BUILDABLE_SCOPE' in neither, false);
  assert.equal('BUILDABLE_PROJECT' in neither, false);
  // the rest of the allowlist still passes
  assert.equal(neither.PATH, process.env.PATH);
});
