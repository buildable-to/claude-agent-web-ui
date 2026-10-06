// /stamp's panel: a token with `scope: "stamp"` and no project. Its
// conversations are tagged apart from every project's, listed apart, and
// their engine is told it makes the stamp, not a project.
//   node --import tsx --test src/server/*.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Query, query } from '@anthropic-ai/claude-agent-sdk';
import { WebSocket } from 'ws';
import type { ServerMessage } from '../shared/protocol.js';
import { Accounts, AuthError, signToken, verifyToken } from './accounts.js';
import { systemAppend } from './live-session.js';
import { SessionManager, sessionEnv } from './session-manager.js';
import { attachWebSocket } from './ws.js';

const SECRET = 'test-secret';
const now = () => Math.floor(Date.now() / 1000);

function folder(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-stamp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An engine that starts and never speaks: what it was started with is the test. */
function engine() {
  const launches: Array<Parameters<typeof query>[0]['options']> = [];
  const factory: typeof query = (args) => {
    launches.push(args.options);
    const stream = (async function* () {
      await new Promise<void>((resolve) => args.options?.abortController?.signal.addEventListener('abort', () => resolve()));
    })();
    return Object.assign(stream, { interrupt: async () => {}, close: () => {} }) as unknown as Query;
  };
  return { factory, launches };
}

const info = (id: string) => ({ sessionId: id, lastModified: 1, summary: id, fileSize: 1 });

test('a stamp token opens the account with the stamp scope and no project', (t) => {
  const root = folder(t);
  const accounts = new Accounts({ root, authSecret: SECRET, claudeConfigPath: join(root, 'claude.json') });
  const a = accounts.resolve(signToken({ sub: 'u1', email: 'e@x.to', scope: 'stamp', exp: now() + 60 }, SECRET), undefined);
  assert.equal(a.scope, 'stamp');
  assert.equal(a.project, undefined);
  // same folder as the account's project panels: one desk, two panels
  const p = accounts.resolve(signToken({ sub: 'u1', sid: 'p1', exp: now() + 60 }, SECRET), undefined);
  assert.equal(p.dir, a.dir);
  assert.equal(p.scope, undefined);
});

test('a scope we do not know, or a scope beside a project, is refused (401)', () => {
  for (const scope of ['project', 'admin', 'Stamp', '', 7, null, ['stamp']]) {
    const t = signToken({ sub: 'u1', exp: now() + 60, scope } as never, SECRET);
    assert.throws(() => verifyToken(t, SECRET), AuthError, `scope ${JSON.stringify(scope)}`);
  }
  assert.throws(() => verifyToken(signToken({ sub: 'u1', sid: 'p1', scope: 'stamp', exp: now() + 60 }, SECRET), SECRET), AuthError);
});

test('lists: /stamp sees only its own; a project panel never sees them, even a project called "stamp"', async (t) => {
  const dir = folder(t);
  // s1 is /stamp's; p1 is about project "stamp" (a name that must not collide);
  // p2 about project q; u1 untagged (a terminal session); x1 tagged both
  // ways (a hand-edited file) stays /stamp's.
  writeFileSync(join(dir, '.agent-projects.json'), JSON.stringify({ p1: 'stamp', p2: 'q', x1: 'q' }));
  writeFileSync(join(dir, '.agent-scopes.json'), JSON.stringify({ s1: 'stamp', x1: 'stamp' }));
  const all = ['s1', 'p1', 'p2', 'u1', 'x1'];
  const m = new SessionManager(dir, 'u', undefined, {
    getSessionInfo: async (id) => (all.includes(id) ? info(id) : undefined),
    listSessions: async () => all.map(info),
  });
  const ids = async (f?: Parameters<SessionManager['list']>[0]) => (await m.list(f)).map((r) => r.sessionId).sort();
  assert.deepEqual(await ids({ scope: 'stamp' }), ['s1', 'x1']);
  assert.deepEqual(await ids({ project: 'stamp' }), ['p1']);
  assert.deepEqual(await ids({ project: 'q' }), ['p2']);
  // a panel with no project (dev, standalone): everything but the scoped ones
  assert.deepEqual(await ids({}), ['p1', 'p2', 'u1']);
  assert.deepEqual(await ids({ project: undefined }), ['p1', 'p2', 'u1']);
  // the usage view (no filter): every conversation
  assert.deepEqual(await ids(), all.sort());
});

test('a /stamp conversation is tagged stamp, runs with BUILDABLE_SCOPE, never with a project', async (t) => {
  const dir = folder(t);
  const cli = engine();
  const m = new SessionManager(dir, 'u1', undefined, { queryFactory: cli.factory });
  // a project handed in beside the scope is dropped, not mixed in
  const s = await m.open(null, { scope: 'stamp', project: 'p9', firstPrompt: 'make our stamp from stamp.dxf' });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.agent-scopes.json'), 'utf8')), { [s.sessionId]: 'stamp' });
  assert.equal(s.project, undefined);
  const env = cli.launches[0]?.env ?? {};
  assert.equal(env.BUILDABLE_SCOPE, 'stamp');
  assert.equal(env.BUILDABLE_ACCOUNT, 'u1');
  assert.equal('BUILDABLE_PROJECT' in env, false);
  const prompt = JSON.stringify(cli.launches[0]?.systemPrompt);
  assert.match(prompt, /company stamp on \/stamp/);
  assert.doesNotMatch(prompt, /Project Studio\. /, 'not the project paragraph');
  // before its first turn is on disk, the new conversation lists on /stamp only
  assert.deepEqual((await m.list({ scope: 'stamp' })).map((r) => r.sessionId), [s.sessionId]);
  assert.deepEqual((await m.list({ project: 'p9' })).map((r) => r.sessionId), []);
  // a project panel's conversation is unchanged
  const p = await m.open(null, { project: 'p1' });
  assert.equal(cli.launches[1]?.env?.BUILDABLE_PROJECT, 'p1');
  assert.equal('BUILDABLE_SCOPE' in (cli.launches[1]?.env ?? {}), false);
  assert.deepEqual((await m.list({ project: 'p1' })).map((r) => r.sessionId), [p.sessionId]);
  m.closeAll();
});

test('a conversation resumes only on the panel it was started on', async (t) => {
  const dir = folder(t);
  writeFileSync(join(dir, '.agent-projects.json'), JSON.stringify({ p1: 'q' }));
  writeFileSync(join(dir, '.agent-scopes.json'), JSON.stringify({ s1: 'stamp' }));
  const cli = engine();
  const m = new SessionManager(dir, 'u1', undefined, { queryFactory: cli.factory, getSessionInfo: async (id) => info(id) });
  await assert.rejects(m.open('s1', { project: 'q' }), /another panel/);
  await assert.rejects(m.open('s1'), /another panel/);
  await assert.rejects(m.open('p1', { scope: 'stamp' }), /another panel/);
  assert.equal(cli.launches.length, 0, 'no engine started for a refused resume');
  await m.open('s1', { scope: 'stamp' });
  assert.equal(cli.launches[0]?.env?.BUILDABLE_SCOPE, 'stamp');
  m.closeAll();
});

test('the env and the prompt paragraph, as functions', () => {
  assert.deepEqual(sessionEnv('u1', 'p1', 'stamp'), { BUILDABLE_ACCOUNT: 'u1', BUILDABLE_SCOPE: 'stamp' });
  assert.deepEqual(sessionEnv('u1', 'p1', undefined), { BUILDABLE_ACCOUNT: 'u1', BUILDABLE_PROJECT: 'p1' });
  assert.deepEqual(sessionEnv(undefined, undefined, undefined), {});
  assert.equal(
    systemAppend({ scope: 'stamp' }),
    "This conversation makes the account's company stamp on /stamp, with the make-stamp skill and stamp_door " +
      '(python -m buildable.services.stamp_door). Drafts never print; the engineer presses Save stamp. ' +
      "For anything about a project, the engineer uses Project Studio's panel.",
  );
  assert.match(systemAppend({ project: 'p1' }), /^The engineer has project p1 open in Project Studio\. /);
  assert.equal(systemAppend({}), '');
  assert.match(systemAppend({ scope: 'stamp', recovery: {} }), /Save stamp\..*\nThe previous engine stopped/s);
});

test("over the socket, a stamp token starts a stamp conversation; a page's leftover project is ignored", async (t) => {
  const dir = folder(t);
  const cli = engine();
  const m = new SessionManager(dir, 'u1', undefined, { queryFactory: cli.factory });
  const server = createServer();
  const wss = attachWebSocket(server, () => ({ manager: m, dir, account: { id: 'u1', scope: 'stamp', dir } }));
  const sockets: WebSocket[] = [];
  t.after(() => { for (const ws of sockets) ws.terminate(); wss.close(); server.close(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws?token=x`);
  sockets.push(ws);
  await new Promise<void>((resolve) => ws.once('open', resolve));
  const next = () => new Promise<ServerMessage>((resolve) => ws.once('message', (raw) => resolve(JSON.parse(String(raw)))));
  // the iframe's sessionStorage may still hold a project from an earlier embed
  const reply = next();
  ws.send(JSON.stringify({ type: 'start', sessionId: null, text: 'make our stamp', project: 'p1' }));
  assert.equal((await reply).type, 'attached');
  const env = cli.launches[0]?.env ?? {};
  assert.equal(env.BUILDABLE_SCOPE, 'stamp');
  assert.equal('BUILDABLE_PROJECT' in env, false);
  assert.equal((await m.list({ scope: 'stamp' })).length, 1);
  assert.equal((await m.list({ project: 'p1' })).length, 0);
  m.closeAll();
});
