// Credits (ezdxf-flask docs/billing.md): the service asks the app before a
// message starts a turn; a clear "no" stops it, anything else lets it run.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import type { Options, Query, query } from '@anthropic-ai/claude-agent-sdk';
import type { ServerMessage } from '../shared/protocol.js';
import type { Account } from './accounts.js';
import { BILLING_AUDIENCE, creditCheck, refusalText, type CreditCheck } from './billing.js';
import { SessionManager } from './session-manager.js';
import { attachWebSocket } from './ws.js';

const SECRET = 'test-secret';

type Call = { url: string; init: RequestInit };

function fakeApp(reply: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('no app address or no secret: nothing is checked', () => {
  assert.equal(creditCheck({ appUrl: undefined, secret: SECRET }), null);
  assert.equal(creditCheck({ appUrl: 'https://app.buildable.to', secret: '' }), null);
  assert.equal(creditCheck({ appUrl: 'not a url', secret: SECRET }), null);
});

test('it asks the app with a token only the billing door accepts', async () => {
  const app = fakeApp(() => json({ allowed: true, reason: 'ok' }));
  const check = creditCheck({ appUrl: 'https://app.buildable.to', secret: SECRET, fetchImpl: app.fetchImpl })!;
  assert.equal(await check('u1'), null);
  const [call] = app.calls;
  assert.equal(call!.url, 'https://app.buildable.to/billing/agent/check');
  assert.equal(call!.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(call!.init.body)), { user_id: 'u1' });
  const auth = (call!.init.headers as Record<string, string>).authorization!;
  const [h, p, s] = auth.replace(/^Bearer /, '').split('.') as [string, string, string];
  assert.equal(createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url'), s);
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  assert.equal(claims.aud, BILLING_AUDIENCE);
  assert.equal(claims.role, 'agent-service');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 120);
});

test("the app's no is the page's message, with where to buy more", async () => {
  const app = fakeApp(() =>
    json({ allowed: false, reason: 'no_credits', message: 'You have used all your credits.', billing_url: 'https://app.buildable.to/billing' }),
  );
  const check = creditCheck({ appUrl: 'https://app.buildable.to', secret: SECRET, fetchImpl: app.fetchImpl })!;
  assert.equal(await check('u1'), 'You have used all your credits. https://app.buildable.to/billing');
  assert.equal(refusalText({ allowed: false }), 'You have no agent credits left.');
});

test('an app that fails, refuses the token or cannot be reached lets the turn run', async () => {
  for (const reply of [() => json({ error: 'x' }, 500), () => json({ error: 'unauthorized' }, 401), () => json({ allowed: 'maybe' })]) {
    const app = fakeApp(reply);
    assert.equal(await creditCheck({ appUrl: 'https://a.test', secret: SECRET, fetchImpl: app.fetchImpl })!('u1'), null);
  }
  const down = fakeApp(() => {
    throw new TypeError('fetch failed');
  });
  assert.equal(await creditCheck({ appUrl: 'https://a.test', secret: SECRET, fetchImpl: down.fetchImpl })!('u1'), null);
});

/** The CLI process replaced: counts launches, keeps every message sent in. */
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
  return { factory, launches };
}

async function socketWith(t: TestContext, credits: CreditCheck) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-billing-'));
  const cli = engine();
  const manager = new SessionManager(dir, 'u1', undefined, { queryFactory: cli.factory });
  // the engines first, then their folder: an engine writes its notes as it closes
  t.after(() => {
    manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  const account: Account = { id: 'u1', project: 'p1', dir };
  const server = createServer();
  const wss = attachWebSocket(server, () => ({ manager, dir, account }), '/ws', { draining: () => false, credits });
  const sockets: WebSocket[] = [];
  t.after(() => {
    for (const ws of sockets) ws.terminate();
    wss.close();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws?token=x`);
  sockets.push(ws);
  await new Promise<void>((resolve) => ws.once('open', resolve));
  const next = () => new Promise<ServerMessage>((resolve) => ws.once('message', (raw) => resolve(JSON.parse(String(raw)))));
  return { ws, next, cli };
}

test('over the socket: out of credits, a message starts no engine and the page is told why', async (t) => {
  const asked: string[] = [];
  const { ws, next, cli } = await socketWith(t, async (id) => {
    asked.push(id);
    return 'You have used all your credits. https://app.buildable.to/billing';
  });

  let reply = next();
  ws.send(JSON.stringify({ type: 'start', sessionId: null, text: 'Reinforce C-1' }));
  const refused = await reply;
  assert.ok(refused.type === 'error' && /used all your credits/.test(refused.message));
  assert.equal(cli.launches.length, 0);
  assert.deepEqual(asked, ['u1']);

  // opening a chat to read it asks nothing and costs nothing
  reply = next();
  ws.send(JSON.stringify({ type: 'start', sessionId: null, text: '' }));
  const attached = await reply;
  assert.equal(attached.type, 'attached');
  assert.equal(asked.length, 1);

  // a message into the open chat is refused too
  assert.ok(attached.type === 'attached');
  reply = next();
  ws.send(JSON.stringify({ type: 'send', sessionId: attached.sessionId, text: 'go on' }));
  const again = await reply;
  assert.ok(again.type === 'error' && /used all your credits/.test(again.message));
  assert.equal(asked.length, 2);
});

test('over the socket: with credits the message goes through', async (t) => {
  const { ws, next, cli } = await socketWith(t, async () => null);
  const reply = next();
  ws.send(JSON.stringify({ type: 'start', sessionId: null, text: 'Reinforce C-1' }));
  assert.equal((await reply).type, 'attached');
  assert.equal(cli.launches.length, 1);
});
