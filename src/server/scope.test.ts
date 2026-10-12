// Element Studio's chat (ezdxf-flask #723): a library conversation never
// touches a project. The app's doors refuse under BUILDABLE_SCOPE=library;
// here the service sets that only from the signed claim, keeps library and
// project conversations apart, and denies the project doors to the engine.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import type { Options, Query, getSessionInfo, query } from '@anthropic-ai/claude-agent-sdk';
import type { ServerMessage } from '../shared/protocol.js';
import { Accounts, AuthError, signToken, type Account } from './accounts.js';
import { LIBRARY_DENIED_TOOLS, LIBRARY_PROMPT, promptAppend } from './live-session.js';
import { LIBRARY_TAG, SessionManager } from './session-manager.js';
import { attachWebSocket } from './ws.js';

const SECRET = 'test-secret';
const now = () => Math.floor(Date.now() / 1000);

function folder(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The CLI process replaced: records what each engine was launched with. */
function engine() {
  const launches: Options[] = [];
  const factory: typeof query = (args) => {
    launches.push(args.options ?? {});
    const signal = args.options?.abortController?.signal;
    const stream = (async function* () {
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
    })();
    return Object.assign(stream, {
      interrupt: async () => {},
      stopTask: async () => {},
      close: () => {},
      initializationResult: () => new Promise(() => {}),
    }) as unknown as Query;
  };
  return { factory, launches, get last() { return launches[launches.length - 1]!; } };
}

/** A folder whose conversations are already on disk, tagged as given. */
function managerWith(t: TestContext, tags: Record<string, string>) {
  const dir = folder(t);
  writeFileSync(join(dir, '.agent-projects.json'), JSON.stringify(tags));
  const cli = engine();
  const info = (async (id: string) =>
    id in tags ? { sessionId: id, summary: `chat ${id}`, lastModified: 1, fileSize: 1 } : undefined) as unknown as typeof getSessionInfo;
  const manager = new SessionManager(dir, 'u1', undefined, { queryFactory: cli.factory, getSessionInfo: info });
  t.after(() => manager.closeAll());
  return { dir, cli, manager };
}

test('a library token opens the library; a project token its project; a token naming both is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-'));
  const accounts = new Accounts({ root, authSecret: SECRET, claudeConfigPath: join(root, 'claude.json') });
  const lib = accounts.resolve(signToken({ sub: 'u1', scope: 'library', exp: now() + 60 }, SECRET), undefined);
  assert.equal(lib.scope, 'library');
  assert.equal(lib.project, undefined);
  const proj = accounts.resolve(signToken({ sub: 'u1', sid: 'p1', exp: now() + 60 }, SECRET), undefined);
  assert.equal(proj.scope, undefined);
  assert.equal(proj.project, 'p1');
  assert.throws(
    () => accounts.resolve(signToken({ sub: 'u1', sid: 'p1', scope: 'library', exp: now() + 60 }, SECRET), undefined),
    (err: unknown) => err instanceof AuthError && /library token must not name a project/.test(err.message),
  );
  // only the exact claim counts
  assert.equal(accounts.resolve(signToken({ sub: 'u1', scope: 'Library', exp: now() + 60 }, SECRET), undefined).scope, undefined);
  // with a secret the URL's scope is nobody's word
  assert.equal(accounts.resolve(signToken({ sub: 'u1', exp: now() + 60 }, SECRET), undefined, 'library').scope, undefined);
  rmSync(root, { recursive: true, force: true });
});

test('dev mode takes ?scope=library for local testing', () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-'));
  const accounts = new Accounts({ root, authSecret: '', claudeConfigPath: join(root, 'claude.json') });
  assert.equal(accounts.resolve(undefined, 'u1', 'library').scope, 'library');
  assert.equal(accounts.resolve(undefined, 'u1').scope, undefined);
  rmSync(root, { recursive: true, force: true });
});

test('a library conversation starts with BUILDABLE_SCOPE=library, no project, the project doors denied, and is tagged', async (t) => {
  process.env.BUILDABLE_PROJECT = 'from-the-service';
  process.env.BUILDABLE_SCOPE = 'library';
  t.after(() => { delete process.env.BUILDABLE_PROJECT; delete process.env.BUILDABLE_SCOPE; });
  const { dir, cli, manager } = managerWith(t, {});
  const session = await manager.open(null, { scope: 'library', project: 'p-sent-anyway' });
  assert.equal(session.scope, 'library');
  assert.equal(session.project, undefined);
  assert.equal(cli.last.env?.BUILDABLE_SCOPE, 'library');
  assert.equal(cli.last.env?.BUILDABLE_PROJECT, undefined);
  assert.equal(cli.last.env?.BUILDABLE_ACCOUNT, 'u1');
  assert.deepEqual(cli.last.disallowedTools, [...LIBRARY_DENIED_TOOLS]);
  assert.ok(cli.last.disallowedTools?.includes('Bash(python -m buildable.services.perceive_project_v4 *)'));
  assert.ok(cli.last.disallowedTools?.includes('Bash(python -m buildable.services.project_files_v4 *)'));
  const prompt = cli.last.systemPrompt as { append?: string };
  assert.ok(prompt.append?.startsWith(LIBRARY_PROMPT));
  assert.match(prompt.append ?? '', /End with what changed, what to look at, what to decide\./);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.agent-projects.json'), 'utf8')), { [session.sessionId]: LIBRARY_TAG });

  // a project conversation never inherits a scope from the service's own env
  const project = await manager.open(null, { project: 'p1' });
  assert.equal(project.scope, undefined);
  assert.equal(cli.last.env?.BUILDABLE_SCOPE, undefined);
  assert.equal(cli.last.env?.BUILDABLE_PROJECT, 'p1');
  assert.equal(cli.last.disallowedTools, undefined);
});

test('the project append is what it was; the library one replaces it', () => {
  assert.equal(
    promptAppend({ project: 'p1' }),
    'The engineer has project p1 open in Project Studio. Work in that project; do not create another one unless asked to in so many words. ' +
      'You are talking to a structural engineer inside their studio: call pieces by their marks and element names, not ids; ' +
      'name sheets by title; no revs, flags, command or tool names; never paste a link to the page they are on. ' +
      'End with what changed, what to look at, what to decide.',
  );
  assert.equal(promptAppend({}), undefined);
  assert.ok(promptAppend({ scope: 'library', project: 'p1' })?.startsWith(LIBRARY_PROMPT));
  assert.doesNotMatch(promptAppend({ scope: 'library' }) ?? '', /Project Studio\./);
  assert.match(promptAppend({ scope: 'library', recovery: {} }) ?? '', /\nThe previous engine stopped/);
});

test('the library lists only library conversations; a project only its own', async (t) => {
  const { manager } = managerWith(t, { lib1: LIBRARY_TAG, lib2: LIBRARY_TAG, a1: 'p1', b1: 'p2' });
  const live = await manager.open(null, { scope: 'library' });
  const library = await manager.list(undefined, 'library');
  assert.deepEqual(library.map((r) => r.sessionId).sort(), ['lib1', 'lib2', live.sessionId].sort());
  assert.ok(library.every((r) => r.scope === 'library' && r.project === undefined));
  const project = await manager.list('p1');
  assert.deepEqual(project.map((r) => r.sessionId), ['a1']);
});

test('a library page resumes only library conversations; a project page never resumes one', async (t) => {
  const { cli, manager } = managerWith(t, { lib1: LIBRARY_TAG, a1: 'p1', loose: 'p9' });
  await assert.rejects(manager.open('a1', { scope: 'library' }), /about a project/);
  await assert.rejects(manager.open('lib1', { project: 'p1' }), /element library/);
  assert.equal(cli.launches.length, 0, 'a refusal starts no engine');
  assert.match(manager.refusal('a1', { library: true }) ?? '', /about a project/);
  assert.match(manager.refusal('untagged', { library: true }) ?? '', /about a project/);
  assert.equal(manager.refusal('lib1', { library: true }), null);
  assert.equal(manager.refusal('a1', { project: 'p1' }), null);

  // resumed from anywhere, a library conversation is still about the library
  const resumed = await manager.open('lib1', {});
  assert.equal(resumed.scope, 'library');
  assert.equal(cli.last.env?.BUILDABLE_SCOPE, 'library');
  assert.equal(cli.last.env?.BUILDABLE_PROJECT, undefined);
  // …and while it runs, a project page still cannot have it
  await assert.rejects(manager.open('lib1', { project: 'p1' }), /element library/);
});

test('over the socket: a library token ignores the page project and cannot attach a project chat', async (t) => {
  const { cli, manager } = managerWith(t, { a1: 'p1' });
  const library: Account = { id: 'u1', scope: 'library', dir: manager.projectDir };
  const server = createServer();
  const wss = attachWebSocket(server, () => ({ manager, dir: manager.projectDir, account: library }));
  const sockets: WebSocket[] = [];
  t.after(() => { for (const ws of sockets) ws.terminate(); wss.close(); server.close(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws?token=x`);
  sockets.push(ws);
  await new Promise<void>((resolve) => ws.once('open', resolve));
  const next = () => new Promise<ServerMessage>((resolve) => ws.once('message', (raw) => resolve(JSON.parse(String(raw)))));

  let reply = next();
  ws.send(JSON.stringify({ type: 'attach', sessionId: 'a1' }));
  const refused = await reply;
  assert.ok(refused.type === 'error' && /about a project/.test(refused.message));

  reply = next();
  ws.send(JSON.stringify({ type: 'start', sessionId: 'a1', text: '' }));
  const noResume = await reply;
  assert.ok(noResume.type === 'error' && /about a project/.test(noResume.message));
  assert.equal(cli.launches.length, 0);

  reply = next();
  ws.send(JSON.stringify({ type: 'start', sessionId: null, text: '', project: 'p1' }));
  const attached = await reply;
  assert.equal(attached.type, 'attached');
  assert.equal(cli.last.env?.BUILDABLE_SCOPE, 'library');
  assert.equal(cli.last.env?.BUILDABLE_PROJECT, undefined);
});

test("an element's page lists that element's library chats alone, and a chat moves with its draft", async (t) => {
  const { manager, dir } = managerWith(t, { a: LIBRARY_TAG, b: LIBRARY_TAG, p: 'abc123' });
  assert.equal(manager.setSubject('a', 'draft:76b82760'), null);
  assert.equal(manager.setSubject('b', 'e119082a'), null);
  assert.deepEqual((await manager.list(undefined, 'library', 'e119082a')).map((r) => r.sessionId), ['b']);
  assert.deepEqual((await manager.list(undefined, 'library')).map((r) => r.sessionId).sort(), ['a', 'b']);
  // the draft became element 37d802ad: its chat follows it there
  assert.equal(manager.setSubject('a', '37d802ad'), null);
  assert.deepEqual((await manager.list(undefined, 'library', '37d802ad')).map((r) => r.sessionId), ['a']);
  assert.deepEqual((await manager.list(undefined, 'library', 'draft:76b82760')), []);
  // a project's chat is never an element's; nonsense is refused
  assert.notEqual(manager.setSubject('p', 'e119082a'), null);
  assert.notEqual(manager.setSubject('a', '../etc'), null);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.agent-subjects.json'), 'utf8')), { a: '37d802ad', b: 'e119082a' });
});
