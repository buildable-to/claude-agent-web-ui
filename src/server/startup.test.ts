import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { type Query, type SDKMessage, type query } from '@anthropic-ai/claude-agent-sdk';
import { build } from 'esbuild';
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
import { SessionManager } from './session-manager.js';
import { attachWebSocket } from './ws.js';

/** Only the SDK's process boundary is inert. Prompts still pass through the
 * real input queue; abort still terminates that engine's async iterator. */
function engineFixture(failFirst = false) {
  const engines: Array<{ sessionId: string; prompts: Array<{ text: string; uuid: string }>; aborted: boolean }> = [];
  const outputs: Array<(message: SDKMessage) => void> = [];
  let attempts = 0;
  const factory: typeof query = (args) => {
    attempts++;
    if (failFirst && attempts === 1) throw new Error('Simulated startup failure');
    const record = {
      sessionId: args.options?.sessionId ?? args.options?.resume ?? '',
      prompts: [] as Array<{ text: string; uuid: string }>,
      aborted: false,
    };
    engines.push(record);
    let ended = false;
    let wake: (() => void) | undefined;
    const messages: SDKMessage[] = [];
    const finish = () => { ended = true; wake?.(); };
    outputs.push((message) => { messages.push(message); wake?.(); });
    args.options?.abortController?.signal.addEventListener('abort', () => {
      record.aborted = true;
      finish();
    });
    const input = args.prompt;
    if (typeof input !== 'string') void (async () => {
      for await (const prompt of input) record.prompts.push({ text: String(prompt.message.content), uuid: String(prompt.uuid) });
    })();
    const stream = (async function* (): AsyncGenerator<SDKMessage> {
      while (!ended) {
        if (!messages.length) await new Promise<void>((resolve) => { wake = resolve; });
        const message = messages.shift();
        if (message) yield message;
      }
    })();
    return Object.assign(stream, { interrupt: async () => {}, stopTask: async () => {}, close: finish }) as unknown as Query;
  };
  return { factory, engines, emit: (index: number, message: SDKMessage) => outputs[index]!(message), get attempts() { return attempts; } };
}

async function until(check: () => unknown | Promise<unknown>, description: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await delay(20);
  }
}

function temporary() {
  return mkdtempSync(join(tmpdir(), 'agent-startup-'));
}

test('overlapping and repeated starts reserve one engine and deduplicate the initial user prompt', async (t) => {
  const cli = engineFixture();
  const dir = temporary();
  const manager = new SessionManager(dir, undefined, undefined, { queryFactory: cli.factory });
  t.after(() => { manager.closeAll(); rmSync(dir, { recursive: true, force: true }); });
  const sessions = await Promise.all(Array.from({ length: 8 }, () => manager.openStarted('request-one', null)));
  assert.equal(cli.engines.length, 1);
  assert.ok(sessions.every((session) => session === sessions[0]));
  for (const session of sessions) session.send('First prompt', 'prompt-one');
  sessions[0]!.send('Second prompt', 'prompt-two');
  sessions[0]!.send('Second prompt', 'prompt-two');
  await until(() => cli.engines[0]?.prompts.length === 2, 'two queued prompts');
  assert.deepEqual(cli.engines[0]!.prompts, [
    { text: 'First prompt', uuid: 'prompt-one' }, { text: 'Second prompt', uuid: 'prompt-two' },
  ]);
  assert.equal(await manager.openStarted('request-one', null), sessions[0]);
  assert.equal(cli.engines.length, 1);
  sessions[0]!.close();
  await assert.rejects(manager.openStarted('request-one', null), /already stopped/);
  assert.equal(cli.engines.length, 1, 'A late retry cannot restart already-stopped work');
});

test('a failed start releases its reservation so explicit retry succeeds once', async (t) => {
  const cli = engineFixture(true);
  const dir = temporary();
  const manager = new SessionManager(dir, undefined, undefined, { queryFactory: cli.factory });
  t.after(() => { manager.closeAll(); rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(manager.openStarted('retryable', null), /startup failure/);
  const session = await manager.openStarted('retryable', null);
  session.send('Kept prompt', 'kept');
  await until(() => cli.engines[0]?.prompts.length === 1, 'retried prompt');
  assert.equal(cli.attempts, 2);
  assert.equal(cli.engines.length, 1);
  assert.equal(await manager.openStarted('retryable', null), session);
});

test('a stopped start cannot attach to a later resumed engine of the same conversation', async (t) => {
  const cli = engineFixture();
  const dir = temporary();
  const manager = new SessionManager(dir, undefined, undefined, {
    queryFactory: cli.factory,
    getSessionInfo: async (id, options) => {
      assert.equal(options?.dir, dir);
      return { sessionId: id, lastModified: 1, summary: 'Beam', fileSize: 1 };
    },
  });
  t.after(() => { manager.closeAll(); rmSync(dir, { recursive: true, force: true }); });
  const first = await manager.openStarted('old-start', null);
  first.send('Make a beam', 'old-prompt');
  await until(() => cli.engines[0]?.prompts.length === 1, 'original prompt');
  first.close();
  const resumed = await manager.open(first.sessionId);
  assert.notEqual(resumed, first);
  assert.equal(resumed.sessionId, first.sessionId);
  await assert.rejects(manager.openStarted('old-start', null), /already stopped/);
  resumed.send('Continue the beam', 'new-prompt');
  await until(() => cli.engines[1]?.prompts.length === 1, 'resumed prompt');
  assert.equal(cli.engines.length, 2);
  assert.deepEqual(cli.engines[1]!.prompts, [{ text: 'Continue the beam', uuid: 'new-prompt' }]);
});

test('start reservations belong to the authenticated account, including equal client request IDs', async (t) => {
  const first = engineFixture(), second = engineFixture();
  const managers = [first, second].map((cli) => new SessionManager(temporary(), undefined, undefined, {
    queryFactory: cli.factory, getSessionInfo: async () => undefined,
  }));
  t.after(() => managers.forEach((manager) => { manager.closeAll(); rmSync(manager.projectDir, { recursive: true, force: true }); }));
  const a = await managers[0]!.openStarted('same-client-id', null);
  const b = await managers[1]!.openStarted('same-client-id', null);
  assert.notEqual(a.sessionId, b.sessionId);
  await assert.rejects(managers[1]!.openStarted('foreign-chat', a.sessionId), /No such conversation/);
  assert.equal(managers[1]!.get(a.sessionId), undefined);
  assert.equal(first.engines.length, 1);
  assert.equal(second.engines.length, 1);
});

type BrowserContext = {
  manager: SessionManager;
  cli: ReturnType<typeof engineFixture>;
  commands: ClientMessage[];
  sockets: Set<WebSocket>;
  hold: boolean;
  held: Array<() => void>;
  holdHistory: boolean;
  histories: ServerResponse[];
  rejectOpen?: () => void;
  failedOpen: boolean;
};

/** Tiny CDP client keeps this integration test independent of browser libraries.
 * Chrome runs in a fresh temporary profile and can reach only our local server. */
async function chrome(t: TestContext, binary: string, dir: string) {
  const child = spawn(binary, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-extensions', '--disable-background-networking',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${join(dir, 'chrome')}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
  let stderr = '';
  let closeBrowser: (() => Promise<unknown>) | undefined;
  const exited = once(child, 'exit');
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  function killGroup(signal: NodeJS.Signals) {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  t.after(async () => {
    if (closeBrowser) {
      // Graceful CDP shutdown waits for profile writes and renderer shutdown.
      // Closing the debugging socket during this command is expected.
      await Promise.race([closeBrowser().catch(() => {}), delay(1_000, undefined, { ref: false })]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      killGroup('SIGTERM');
      await Promise.race([exited, delay(3_000, undefined, { ref: false })]);
    }
    // Only the process group created for this disposable browser is targeted;
    // descendants must be gone before removing their still-mutable profile.
    killGroup('SIGKILL');
    await exited;
  });
  const portFile = join(dir, 'chrome', 'DevToolsActivePort');
  await until(() => {
    if (child.exitCode !== null) throw new Error(`Chrome exited: ${stderr}`);
    return existsSync(portFile);
  }, 'Chrome debugger startup');
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
  const page = pages.find((entry) => entry.type === 'page' && entry.url === 'about:blank');
  assert.ok(page, 'Chrome exposes the isolated blank test tab');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  t.after(() => socket.terminate());
  await once(socket, 'open');
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  socket.on('close', () => { for (const entry of pending.values()) entry.reject(new Error('Chrome debugger closed')); });
  async function command(method: string, params: Record<string, unknown> = {}) {
    const id = nextId++;
    const reply = new Promise<Record<string, unknown>>((resolve, reject) => pending.set(id, { resolve, reject }));
    socket.send(JSON.stringify({ id, method, params }));
    return reply;
  }
  async function evaluate(expression: string) {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return (result.result as { value?: unknown }).value;
  }
  closeBrowser = () => command('Browser.close');
  return { command, evaluate };
}

const chromeBinary = process.env.CHROME_BIN ?? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
test('mounted composer keeps startup prompts in their conversation through attachment, reconnect, failure, navigation and stop', {
  skip: chromeBinary ? false : 'Install Chrome/Chromium or set CHROME_BIN to run browser integration coverage',
  timeout: 90_000,
}, async (t) => {
  const dir = temporary();
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const bundled = await build({
    absWorkingDir: root,
    entryPoints: ['test/browser/startup.tsx'],
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    tsconfig: join(root, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.BASE_URL': '"/"' },
  });
  const script = bundled.outputFiles[0]!.contents;
  const contexts = new Map<string, BrowserContext>();
  function context(account: string) {
    let ctx = contexts.get(account);
    if (!ctx) {
      const cli = engineFixture(account === 'failure-retry');
      const manager = new SessionManager(temporary(), undefined, undefined, {
        queryFactory: cli.factory,
        getSessionInfo: async (id) => {
          if (id !== 'saved-beam') return undefined;
          if (account === 'known-failed-navigation' && !ctx!.failedOpen) {
            await new Promise<void>((_resolve, reject) => {
              ctx!.rejectOpen = () => {
                ctx!.failedOpen = true;
                delete ctx!.rejectOpen;
                reject(new Error('Simulated resume failure'));
              };
            });
          }
          return { sessionId: id, lastModified: 1, summary: 'Beam', fileSize: 1 };
        },
      });
      ctx = { manager, cli, commands: [], sockets: new Set(), hold: true, held: [], holdHistory: false, histories: [], failedOpen: false };
      contexts.set(account, ctx);
    }
    return ctx;
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/bundle.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(script);
    } else if (url.pathname === '/control') {
      const ctx = context(url.searchParams.get('account')!);
      const action = url.searchParams.get('action');
      if (action === 'release') {
        ctx.hold = false;
        for (const send of ctx.held.splice(0)) send();
      } else if (action === 'release-first') {
        ctx.held.shift()?.();
      } else if (action === 'release-last') {
        ctx.held.pop()?.();
      } else if (action === 'emit-output') {
        ctx.cli.emit(0, {
          type: 'assistant', uuid: randomUUID(), session_id: ctx.cli.engines[0]!.sessionId, parent_tool_use_id: null,
          message: { role: 'assistant', content: [{ type: 'text', text: 'The beam is ready for review.' }] },
        } as unknown as SDKMessage);
      } else if (action === 'hold-history') {
        ctx.holdHistory = true;
      } else if (action === 'release-history') {
        ctx.holdHistory = false;
        for (const response of ctx.histories.splice(0)) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('[]');
        }
      } else if (action === 'fail-open') {
        ctx.rejectOpen?.();
      } else if (action === 'disconnect') {
        // Lose an attachment that was already generated by the real server.
        // The real WsClient reconnects and repeats its reserved start.
        ctx.held.length = 0;
        ctx.hold = false;
        for (const socket of ctx.sockets) socket.close();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ commands: ctx.commands, engines: ctx.cli.engines, attempts: ctx.cli.attempts,
        attachments: ctx.held.length, historyWaiting: ctx.histories.length, openWaiting: Boolean(ctx.rejectOpen) }));
    } else if (url.pathname.startsWith('/api/')) {
      if (url.pathname.endsWith('/messages')) {
        const ctx = context(url.searchParams.get('account')!);
        if (ctx.holdHistory) { ctx.histories.push(res); return; }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(url.pathname.endsWith('/messages') ? '[]' : '{}');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    }
  });
  const wss = attachWebSocket(server, (_token, account) => {
    assert.ok(account);
    const ctx = context(account);
    return { manager: ctx.manager, dir: ctx.manager.projectDir };
  });
  wss.on('connection', (socket, req) => {
    const ctx = context(new URL(req.url!, 'http://localhost').searchParams.get('account')!);
    ctx.sockets.add(socket);
    socket.on('close', () => ctx.sockets.delete(socket));
    socket.on('message', (raw) => ctx.commands.push(JSON.parse(String(raw))));
    const send = socket.send.bind(socket);
    // A network delivery seam: all production message handling remains real.
    socket.send = ((data: Parameters<typeof socket.send>[0], ...args: unknown[]) => {
      const message = JSON.parse(String(data)) as ServerMessage;
      if (message.type === 'attached' && ctx.hold) {
        ctx.held.push(() => { if (socket.readyState === WebSocket.OPEN) send(data); });
      } else Reflect.apply(send, socket, [data, ...args]);
    }) as typeof socket.send;
  });
  t.after(() => {
    for (const ctx of contexts.values()) {
      for (const socket of ctx.sockets) socket.terminate();
      ctx.manager.closeAll();
      rmSync(ctx.manager.projectDir, { recursive: true, force: true });
    }
    wss.close();
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const browser = await chrome(t, chromeBinary!, dir);
  // Chrome's renderer children may finish profile writes just after the main
  // process exits. Retry that narrowly bounded cleanup instead of flaking.
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  for (const scenario of ['delayed-enter', 'delayed-button', 'attached-control', 'lost-reply', 'failure-retry',
    'switch-chat', 'switch-back', 'known-failed-navigation', 'known-history-race', 'stop-startup']) {
    await t.test(scenario, async () => {
      await browser.command('Page.navigate', { url: `http://127.0.0.1:${address.port}/?account=${scenario}` });
      await until(async () => await browser.evaluate(`location.search === '?account=${scenario}' && typeof startupResult !== 'undefined'`), 'browser fixture loaded');
      const result = await browser.evaluate('startupResult');
      assert.ok(result, 'Browser completed all assertions');
    });
  }
});
