import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { ServerConfig } from '../shared/protocol.js';
import { Accounts, AuthError, defaultClaudeConfigPath, type Account } from './accounts.js';
import { loadConfig, projectName } from './config.js';
import { Copies } from './copies.js';
import { createDrainController } from './drain.js';
import { HOP, NOT_MINE, isHop, passHttp, passUpgrade } from './handoff.js';
import { SessionManager } from './session-manager.js';
import { LoginError, sharedLogins } from './logins.js';
import { ConnectError, sharedConnector } from './connect.js';
import { buildTree } from './tree.js';
import { MAX_FILE_BYTES, saveAttachment } from './attachments.js';
import { attachWebSocket, scopeOf, type Resolver } from './ws.js';
import { creditCheck } from './billing.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();

// Two modes. Single: one --dir, no auth (the laptop case). Accounts: one
// folder per account under --agents-root, picked from the app's token.
if (config.agentsRoot && !config.authSecret && !config.devAuth) {
  console.error('AGENTS_ROOT is set but AGENT_AUTH_SECRET is empty. Refusing to serve every account to anyone.');
  console.error('Set the secret, or pass --dev-auth to run the unauthenticated dev mode on a laptop.');
  process.exit(2);
}
const accounts = config.agentsRoot
  ? new Accounts({
      root: config.agentsRoot,
      authSecret: config.authSecret,
      ...(config.accountTemplate ? { settingsTemplate: config.accountTemplate } : {}),
      claudeConfigPath: defaultClaudeConfigPath(),
    })
  : null;
const single = accounts ? null : new SessionManager(config.projectDir);
// Across a deploy two versions run side by side and an account is on exactly
// one of them (copies.ts, ezdxf-flask #1457). Off without AGENT_COPIES_DIR.
const copies = new Copies({ ...(accounts && process.env.AGENT_COPIES_DIR ? { dir: process.env.AGENT_COPIES_DIR } : {}), port: config.port });
if (copies.diedRetiring) {
  console.log('[copies] this copy died while retiring: its accounts go to the newest copy');
  copies.leave();
  process.exit(0);
}
/** Calls and messages being handled now, per account: a retiring copy never
 *  lets an account go under one (it would finish on a closed folder). */
const inFlight = new Map<string, number>();
function hold(accountId: string | undefined): () => void {
  if (!accountId) return () => {};
  inFlight.set(accountId, (inFlight.get(accountId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (inFlight.get(accountId) ?? 1) - 1;
    if (left > 0) inFlight.set(accountId, left);
    else inFlight.delete(accountId);
  };
}
/** Take the account for this copy; false when another copy has it. */
const mine = (accountId: string) => copies.claim(accountId) === copies.port;
/** Where a request for the account is served: here (null), on the copy at
 *  that port, or nowhere this copy can reach ('gone': retry at the front door). */
function placeOf(accountId: string, hop: boolean): number | 'gone' | null {
  const owner = copies.claim(accountId);
  if (owner === copies.port) return null;
  return owner === null || hop ? 'gone' : owner;
}
try {
  const n = accounts?.sendWaitingRuns(mine) ?? 0;
  if (n) console.log(`[runs] sending what ${n} account folder(s) kept from before`);
} catch (err) {
  console.error(`[runs] could not look for waiting runs: ${String(err)}`);
}

export type Ctx = { manager: SessionManager; dir: string; account?: Account };

/** Who is asking, and which folder that means. Throws AuthError. */
const resolveCtx: Resolver = (token, devAccount, devScope) => {
  if (!accounts) return { manager: single as SessionManager, dir: config.projectDir };
  // an account's folder has one writer: never open it beside the copy that holds it
  if (!mine(accounts.identify(token, devAccount))) throw new AuthError('this account is on another copy of the agent');
  const account = accounts.resolve(token, devAccount, devScope);
  return { manager: accounts.manager(account), dir: account.dir, account };
};

const app = express();
const base = config.basePath; // '' or '/agent'

// Who may frame the page: itself (nginx serves the studio and /agent from one
// host) and the studio named by BUILDABLE_URL (a laptop, where the app is on
// another port). Anyone else framing it would receive what the engineer
// types, through the parent messages.
const studioOrigin = (() => {
  try {
    return process.env.BUILDABLE_URL ? new URL(process.env.BUILDABLE_URL).origin : '';
  } catch {
    return '';
  }
})();
app.use((_req, res, next) => {
  // images only from this site (and inline/blob): nothing a reply contains loads from elsewhere
  res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${studioOrigin}`.trim() + `; img-src 'self' data: blob: ${studioOrigin}`.trimEnd());
  next();
});

// Nothing here needs a token; the deploy asks it whether the new copy is up.
app.get(`${base}/healthz`, (_req, res) => {
  res.json({ ok: true, retiring: copies.retiring });
});

// An account another copy holds is served by that copy: its calls go there
// whole, before anything here reads the body or opens the folder.
app.use(`${base}/api`, (req, res, next) => {
  if (!accounts || !copies.enabled || req.path.startsWith('/admin/')) {
    next();
    return;
  }
  let id: string;
  try {
    const auth = req.header('authorization');
    id = accounts.identify(auth?.startsWith('Bearer ') ? auth.slice(7) : firstString(req.query.token), firstString(req.query.account));
  } catch {
    next(); // the token check below answers
    return;
  }
  const gone = () => res.status(503).set(NOT_MINE, '1').set('retry-after', '1').json({ error: 'The agent is moving to a new version. Try again.' });
  const place = placeOf(id, isHop(req));
  if (place === null) {
    res.on('close', hold(id));
    next();
  } else if (place === 'gone') gone();
  // the owner may let the account go while the call is on its way: a call
  // without a body is then served here
  else {
    passHttp(req, res, place, req.method === 'GET'
      ? () => {
          if (!mine(id)) return gone();
          res.on('close', hold(id));
          next();
        }
      : undefined);
  }
});

// Only the API needs the token; the page and its assets load without one and
// the browser then sends the token it was given on its URL.
app.use(`${base}/api`, (req, res, next) => {
  // the admin routes check their own (admin) token and must not make a folder for it
  if (req.path.startsWith('/admin/')) {
    next();
    return;
  }
  const auth = req.header('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : firstString(req.query.token);
  try {
    res.locals.ctx = resolveCtx(token, firstString(req.query.account), firstString(req.query.scope));
    next();
  } catch (err) {
    const status = err instanceof AuthError ? 401 : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
// a view-only page (an admin reading an account's chats) reads, never writes
app.use(`${base}/api`, (req, res, next) => {
  if (!req.path.startsWith('/admin/') && (res.locals.ctx as Ctx | undefined)?.account?.viewOnly && req.method !== 'GET') {
    res.status(403).json({ error: 'This chat is view only' });
    return;
  }
  next();
});
// bodies are read only for callers who passed the token check
app.use(`${base}/api`, express.json({ limit: '2mb' }));

const ctxOf = (res: express.Response) => res.locals.ctx as Ctx;

// A file the engineer attaches to a message, sent as its raw bytes before
// the message itself; the message then names what this returns.
app.post(
  `${base}/api/attachments`,
  express.raw({ type: () => true, limit: MAX_FILE_BYTES }),
  (req, res, next) => {
    try {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const name = firstString(req.query.name) ?? 'file';
      res.json(saveAttachment(ctxOf(res).dir, name, req.header('content-type') ?? '', body));
    } catch (err) {
      if (err instanceof Error && /too large|empty/.test(err.message)) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  },
);

app.get(`${base}/api/config`, (_req, res) => {
  const { dir, account } = ctxOf(res);
  const body: ServerConfig = {
    projectDir: dir,
    projectName: account?.email ?? account?.id ?? projectName(dir),
    version: '0.1.0',
    ...(account ? { account: { id: account.id, ...(account.email ? { email: account.email } : {}) } } : {}),
    ...(account?.project ? { project: account.project } : {}),
    ...(account?.scope ? { scope: account.scope } : {}),
    ...(account?.viewOnly ? { viewOnly: true } : {}),
  };
  res.json(body);
});

app.get(`${base}/api/engine`, async (_req, res, next) => {
  try {
    res.json(await ctxOf(res).manager.engineInfo());
  } catch (err) {
    next(err);
  }
});

app.get(`${base}/api/tree`, async (_req, res, next) => {
  try {
    res.json(await buildTree(ctxOf(res).dir));
  } catch (err) {
    next(err);
  }
});

// The list is narrowed by the token: a library page sees only the library's
// conversations, a project page only its project's (the page's own
// `?project=` counts only where the token names none).
app.get(`${base}/api/sessions`, async (req, res, next) => {
  try {
    const { manager, account } = ctxOf(res);
    if (account?.scope === 'library') {
      const subject = firstString(req.query.subject);
      res.json(await manager.list(undefined, 'library', subject || undefined));
      return;
    }
    res.json(await manager.list(account?.project ?? firstString(req.query.project)));
  } catch (err) {
    next(err);
  }
});

/** A conversation outside the page's scope is not read, renamed or deleted from it. */
function refuseOutOfScope(req: express.Request, res: express.Response): boolean {
  const { manager, account } = ctxOf(res);
  const refused = manager.refusal(String(req.params.id), scopeOf(account));
  if (refused) res.status(403).json({ error: refused });
  return Boolean(refused);
}

app.get(`${base}/api/sessions/:id/messages`, async (req, res, next) => {
  try {
    if (refuseOutOfScope(req, res)) return;
    res.json(await ctxOf(res).manager.history(String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

app.patch(`${base}/api/sessions/:id`, async (req, res, next) => {
  try {
    // an element's page says which element a library conversation is about
    if (typeof req.body?.subject === 'string') {
      if (refuseOutOfScope(req, res)) return;
      const refused = ctxOf(res).manager.setSubject(String(req.params.id), req.body.subject);
      if (refused) {
        res.status(400).json({ error: refused });
        return;
      }
      res.json({ ok: true });
      return;
    }
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    if (refuseOutOfScope(req, res)) return;
    await ctxOf(res).manager.rename(String(req.params.id), title);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete(`${base}/api/sessions/:id`, async (req, res, next) => {
  try {
    if (refuseOutOfScope(req, res)) return;
    await ctxOf(res).manager.remove(String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- the usage view (admin token only): every account's conversations, and Stop
app.get(`${base}/api/admin/overview`, async (req, res) => {
  try {
    if (!accounts) throw new AuthError('no accounts mode');
    const auth = req.header('authorization');
    accounts.verifyAdmin(auth?.startsWith('Bearer ') ? auth.slice(7) : undefined);
    const out: unknown[] = [];
    for (const account of accounts.listAccounts()) {
      // each copy answers for the accounts it holds; the one asked adds the others'
      if (!(isHop(req) ? copies.ownerOf(account.id) === copies.port : mine(account.id))) continue;
      const manager = accounts.manager(account);
      const sessions = await manager.list();
      const live = manager.liveSessions().length;
      const costUsd = sessions.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
      out.push({ id: account.id, email: account.email, live, costUsd, sessions });
    }
    if (!isHop(req)) {
      for (const other of copies.others()) {
        try {
          const r = await fetch(`http://127.0.0.1:${other.port}${base}/api/admin/overview`, { headers: { authorization: auth ?? '', [HOP]: '1' } });
          if (r.ok) out.push(...((await r.json()) as { accounts: unknown[] }).accounts);
        } catch (err) {
          console.error(`[copies] no overview from the copy on ${other.port}: ${String(err)}`);
        }
      }
    }
    res.json({ accounts: out, generatedAt: Date.now() });
  } catch (err) {
    res.status(err instanceof AuthError ? 401 : 500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Claude logins (admin token only): which Claude subscription the chats run on
function adminOnly(req: express.Request) {
  if (!accounts) throw new AuthError('no accounts mode');
  const auth = req.header('authorization');
  accounts.verifyAdmin(auth?.startsWith('Bearer ') ? auth.slice(7) : undefined);
  return accounts;
}

function loginsReply(res: express.Response, extra: Record<string, unknown> = {}) {
  res.json({ logins: sharedLogins().list(), ...extra });
}

function loginsFailed(res: express.Response, err: unknown) {
  const status = err instanceof AuthError ? 401 : err instanceof LoginError || err instanceof ConnectError ? 400 : 500;
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
}

app.get(`${base}/api/admin/logins`, (req, res) => {
  try {
    adminOnly(req);
    loginsReply(res);
  } catch (err) {
    loginsFailed(res, err);
  }
});

app.post(`${base}/api/admin/logins`, (req, res) => {
  try {
    adminOnly(req);
    const body = (req.body ?? {}) as { name?: unknown; token?: unknown };
    sharedLogins().add(String(body.name ?? ''), String(body.token ?? ''));
    loginsReply(res);
  } catch (err) {
    loginsFailed(res, err);
  }
});

/** Connect a Claude account: start Claude's own sign-in here and hand back
 *  its link; the admin signs in and pastes the code Claude shows. */
app.post(`${base}/api/admin/logins/connect`, async (req, res) => {
  try {
    adminOnly(req);
    res.json(await sharedConnector().start());
  } catch (err) {
    loginsFailed(res, err);
  }
});

app.post(`${base}/api/admin/logins/connect/:id`, async (req, res) => {
  try {
    adminOnly(req);
    const body = (req.body ?? {}) as { code?: unknown; name?: unknown };
    const token = await sharedConnector().finish(String(req.params.id), String(body.code ?? ''));
    const n = sharedLogins().list().length; // the server login is row 1
    sharedLogins().add(String(body.name ?? '').trim() || `Claude account ${n}`, token);
    loginsReply(res);
  } catch (err) {
    loginsFailed(res, err);
  }
});

app.delete(`${base}/api/admin/logins/connect/:id`, (req, res) => {
  try {
    adminOnly(req);
    sharedConnector().cancel(String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    loginsFailed(res, err);
  }
});

/** Make a login the active one. Idle chats close so their next message
 *  starts on it; a chat mid-turn keeps the old login until its turn ends. */
app.post(`${base}/api/admin/logins/:id/use`, (req, res) => {
  try {
    const all = adminOnly(req);
    sharedLogins().use(String(req.params.id));
    let restarted = 0;
    for (const account of all.listAccounts()) restarted += all.manager(account).closeIdle();
    console.log(`[logins] now using ${String(req.params.id)}; ${restarted} idle chat(s) restarted`);
    loginsReply(res, { restarted });
  } catch (err) {
    loginsFailed(res, err);
  }
});

app.patch(`${base}/api/admin/logins/:id`, (req, res) => {
  try {
    adminOnly(req);
    sharedLogins().rename(String(req.params.id), String(((req.body ?? {}) as { name?: unknown }).name ?? ''));
    loginsReply(res);
  } catch (err) {
    loginsFailed(res, err);
  }
});

app.delete(`${base}/api/admin/logins/:id`, (req, res) => {
  try {
    const all = adminOnly(req);
    const id = String(req.params.id);
    const wasActive = sharedLogins().current().id === id;
    sharedLogins().remove(id);
    // a removed login is gone for idle chats too
    let restarted = 0;
    if (wasActive) for (const account of all.listAccounts()) restarted += all.manager(account).closeIdle();
    loginsReply(res, { restarted });
  } catch (err) {
    loginsFailed(res, err);
  }
});

app.post(`${base}/api/admin/sessions/:id/stop`, async (req, res) => {
  try {
    if (!accounts) throw new AuthError('no accounts mode');
    const auth = req.header('authorization');
    accounts.verifyAdmin(auth?.startsWith('Bearer ') ? auth.slice(7) : undefined);
    const id = String(req.params.id);
    // a running chat is in a manager this lifetime opened, here or on another copy
    for (const { id: account, manager } of accounts.opened()) {
      if (await manager.stop(id)) {
        res.json({ ok: true, account });
        return;
      }
    }
    if (!isHop(req)) {
      for (const other of copies.others()) {
        try {
          const r = await fetch(`http://127.0.0.1:${other.port}${base}/api/admin/sessions/${encodeURIComponent(id)}/stop`, {
            method: 'POST',
            headers: { authorization: auth ?? '', [HOP]: '1' },
          });
          if (r.ok) {
            res.json(await r.json());
            return;
          }
        } catch (err) {
          console.error(`[copies] could not ask the copy on ${other.port} to stop a chat: ${String(err)}`);
        }
      }
    }
    res.status(404).json({ error: 'not running' });
  } catch (err) {
    res.status(err instanceof AuthError ? 401 : 500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[api]', message);
  res.status(500).json({ error: message });
});

// In production the built web app is served from the same port.
const webDist = resolve(here, '../../web');
if (existsSync(webDist)) {
  const escaped = base.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  // An account another copy holds gets that copy's page too, so the page and
  // the server it talks to are one version. The page's URL carries the token.
  app.get(new RegExp(`^${escaped}(?!/api/|/assets/).*`), (req, res, next) => {
    const token = firstString(req.query.token);
    const dev = firstString(req.query.account);
    if (!accounts || !copies.enabled || isHop(req) || (!token && !dev)) {
      next();
      return;
    }
    let owner: number | null = null;
    try {
      owner = copies.ownerOf(accounts.identify(token, dev));
    } catch {
      // a bad token gets this copy's page, which says so
    }
    if (owner === null || owner === copies.port) next();
    else passHttp(req, res, owner, next);
  });
  app.use(base || '/', express.static(webDist));
  // That page's scripts are named by their content and asked for without a
  // token: one this build does not have is another copy's.
  app.get(new RegExp(`^${escaped}/assets/`), (req, res) => {
    const ports = isHop(req) ? [] : copies.others().map((c) => c.port);
    const tryNext = () => {
      const port = ports.shift();
      if (port === undefined) res.status(404).end();
      else passHttp(req, res, port, tryNext);
    };
    if (isHop(req)) res.status(404).set(NOT_MINE, '1').end();
    else tryNext();
  });
  app.get(new RegExp(`^${escaped}(?!/api/).*`), (_req, res) => res.sendFile(resolve(webDist, 'index.html')));
}

const server = createServer(app);
// Credits are checked only where accounts are (the shared server), against
// the app at BUILDABLE_URL with the secret the two share (ezdxf-flask
// docs/billing.md). A laptop has neither and checks nothing.
const credits = accounts ? creditCheck({ appUrl: process.env.BUILDABLE_URL, secret: config.authSecret }) : null;
const wss = attachWebSocket(server, resolveCtx, `${base}/ws`, {
  // side by side, a retiring copy keeps serving the accounts it holds
  draining: () => drain.draining && !copies.enabled,
  credits,
  place: (req, url) => {
    if (!accounts || !copies.enabled) return null;
    try {
      return placeOf(accounts.identify(url.searchParams.get('token') ?? undefined, url.searchParams.get('account') ?? undefined), isHop(req));
    } catch {
      return null; // the handshake's own token check answers
    }
  },
  pass: passUpgrade,
  hold,
});
// What our own stop (a deploy) cut goes on by itself. AGENT_AUTO_CONTINUE=0 turns it off.
// An account's folder is opened once in a lifetime, at start or when the
// account first comes here (from a copy that let it go, was ended, or died):
// that is the moment its cut work is continued, whichever way it came.
if (accounts && process.env.AGENT_AUTO_CONTINUE !== '0') {
  const continued = new Set<string>();
  const continueCut = (accountId: string, manager: SessionManager) => {
    if (continued.has(accountId)) return;
    continued.add(accountId);
    manager
      .continueStopped(async () => !credits || !(await credits(accountId)))
      .then((n) => { if (n) console.log(`[sessions] continued ${n} conversation(s) of ${accountId} a stop cut`); })
      .catch((err) => console.error(`[sessions] could not continue ${accountId}: ${String(err)}`));
  };
  // a folder this copy lets go and later gets back is opened afresh
  accounts.onOpen = (accountId, manager) => {
    continued.delete(accountId);
    continueCut(accountId, manager);
  };
  // the folders opened above, before this was set (runs waiting to be sent)
  for (const { id, manager } of accounts.opened()) continueCut(id, manager);
  accounts.openStopped(mine);
}

server.listen(config.port, config.host, () => {
  console.log(`claude-agent-web-ui listening on http://${config.host}:${config.port}${base}/`);
  if (accounts) {
    console.log(`accounts under: ${config.agentsRoot} (${config.authSecret ? 'token auth' : 'DEV MODE, no auth'})`);
  } else {
    console.log(`project: ${config.projectDir}`);
  }
});

// A stop (a deploy, a manual restart) drains: no new turn starts, running
// turns, pending approvals, and background builders get up to AGENT_DRAIN_MINUTES
// (default 25; the unit's TimeoutStopSec must be longer) to finish, then the process
// exits. Ctrl-C twice on a laptop skips the wait.
function stopNow(reason: string) {
  console.log(reason);
  // a copy that leaves with work still open keeps its owner files: the newest
  // copy finds them, takes the accounts over and continues what was cut
  if ((accounts?.busy() ?? 0) === 0) copies.leave();
  else copies.forget();
  accounts?.closeAll();
  single?.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
// Side by side: once a second, a retiring copy lets go of every account that
// has had no work for a quiet minute (a helper ending and the turn it wakes
// are a moment apart), and the copy that serves takes over what a dead copy
// left behind.
const quietMs = Number(process.env.AGENT_RELEASE_QUIET_SECONDS ?? 60) * 1000;
const lastBusy = new Map<string, number>();
let ticks = 0;
function closeSockets(accountId: string) {
  for (const ws of wss.clients) {
    if ((ws as { accountId?: string }).accountId === accountId) ws.close(1012, 'moved to the new version');
  }
}
function adopt(accountId: string) {
  const account = accounts?.listAccounts().find((a) => a.id === accountId);
  if (!accounts || !account || !mine(accountId)) return;
  console.log(`[copies] taking over ${accountId} from a copy that is gone`);
  accounts.manager(account); // opening it continues what was cut (onOpen)
}
if (accounts && copies.enabled) {
  setInterval(() => {
    const now = Date.now();
    for (const { id, manager } of accounts.opened()) {
      if (manager.busy() > 0 || inFlight.has(id) || !lastBusy.has(id)) lastBusy.set(id, now);
      else if (copies.retiring && now - (lastBusy.get(id) ?? now) >= quietMs) {
        console.log(`[copies] ${id} has no work: it goes to the newest copy`);
        closeSockets(id);
        accounts.drop(id);
        copies.release(id);
        lastBusy.delete(id);
      }
    }
    if (!copies.retiring && ++ticks % 15 === 0) {
      for (const id of copies.orphaned()) adopt(id);
    }
  }, 1000).unref();
}
const drain = createDrainController({
  // side by side the copy is done when it holds no account, not when no turn runs
  busy: () => (copies.enabled ? accounts?.opened().length : (accounts ?? single)?.busy()) ?? 0,
  stop: stopNow,
  log: console.log,
  timeoutMs: Number(process.env.AGENT_DRAIN_MINUTES ?? 25) * 60 * 1000,
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    copies.retire();
    drain.signal(signal);
  });
}

function firstString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}
