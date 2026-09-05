import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { ServerConfig } from '../shared/protocol.js';
import { Accounts, AuthError, defaultClaudeConfigPath, type Account } from './accounts.js';
import { loadConfig, projectName } from './config.js';
import { SessionManager } from './session-manager.js';
import { buildTree } from './tree.js';
import { attachWebSocket, type Resolver } from './ws.js';

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

export type Ctx = { manager: SessionManager; dir: string; account?: Account };

/** Who is asking, and which folder that means. Throws AuthError. */
const resolveCtx: Resolver = (token, devAccount) => {
  if (!accounts) return { manager: single as SessionManager, dir: config.projectDir };
  const account = accounts.resolve(token, devAccount);
  return { manager: accounts.manager(account), dir: account.dir, account };
};

const app = express();
app.use(express.json({ limit: '2mb' }));
const base = config.basePath; // '' or '/agent'

// Only the API needs the token; the page and its assets load without one and
// the browser then sends the token it was given on its URL.
app.use(`${base}/api`, (req, res, next) => {
  const auth = req.header('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : firstString(req.query.token);
  try {
    res.locals.ctx = resolveCtx(token, firstString(req.query.account));
    next();
  } catch (err) {
    const status = err instanceof AuthError ? 401 : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const ctxOf = (res: express.Response) => res.locals.ctx as Ctx;

app.get(`${base}/api/config`, (_req, res) => {
  const { dir, account } = ctxOf(res);
  const body: ServerConfig = {
    projectDir: dir,
    projectName: account?.email ?? account?.id ?? projectName(dir),
    version: '0.1.0',
    ...(account ? { account: { id: account.id, ...(account.email ? { email: account.email } : {}) } } : {}),
    ...(account?.project ? { project: account.project } : {}),
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

app.get(`${base}/api/sessions`, async (req, res, next) => {
  try {
    const project = firstString(req.query.project);
    res.json(await ctxOf(res).manager.list(project));
  } catch (err) {
    next(err);
  }
});

app.get(`${base}/api/sessions/:id/messages`, async (req, res, next) => {
  try {
    res.json(await ctxOf(res).manager.history(String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

app.patch(`${base}/api/sessions/:id`, async (req, res, next) => {
  try {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    await ctxOf(res).manager.rename(String(req.params.id), title);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete(`${base}/api/sessions/:id`, async (req, res, next) => {
  try {
    await ctxOf(res).manager.remove(String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
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
  app.use(base || '/', express.static(webDist));
  const escaped = base.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  app.get(new RegExp(`^${escaped}(?!/api/).*`), (_req, res) => res.sendFile(resolve(webDist, 'index.html')));
}

const server = createServer(app);
attachWebSocket(server, resolveCtx, `${base}/ws`);

server.listen(config.port, config.host, () => {
  console.log(`claude-agent-web-ui listening on http://${config.host}:${config.port}${base}/`);
  if (accounts) {
    console.log(`accounts under: ${config.agentsRoot} (${config.authSecret ? 'token auth' : 'DEV MODE, no auth'})`);
  } else {
    console.log(`project: ${config.projectDir}`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal}: shutting down`);
    accounts?.closeAll();
    single?.closeAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

function firstString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}
