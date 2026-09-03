import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { ServerConfig } from '../shared/protocol.js';
import { loadConfig, projectName } from './config.js';
import { SessionManager } from './session-manager.js';
import { buildTree } from './tree.js';
import { attachWebSocket } from './ws.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const sessions = new SessionManager(config.projectDir);

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/api/config', (_req, res) => {
  const body: ServerConfig = {
    projectDir: config.projectDir,
    projectName: projectName(config.projectDir),
    version: '0.1.0',
  };
  res.json(body);
});

app.get('/api/commands', async (_req, res, next) => {
  try {
    res.json(await sessions.commands());
  } catch (err) {
    next(err);
  }
});

app.get('/api/tree', async (_req, res, next) => {
  try {
    res.json(await buildTree(config.projectDir));
  } catch (err) {
    next(err);
  }
});

app.get('/api/sessions', async (_req, res, next) => {
  try {
    res.json(await sessions.list());
  } catch (err) {
    next(err);
  }
});

app.get('/api/sessions/:id/messages', async (req, res, next) => {
  try {
    res.json(await sessions.history(String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

app.patch('/api/sessions/:id', async (req, res, next) => {
  try {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    await sessions.rename(String(req.params.id), title);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/sessions/:id', async (req, res, next) => {
  try {
    await sessions.remove(String(req.params.id));
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
  app.use(express.static(webDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(resolve(webDist, 'index.html')));
}

const server = createServer(app);
attachWebSocket(server, sessions);

server.listen(config.port, config.host, () => {
  console.log(`claude-agent-web-ui listening on http://${config.host}:${config.port}`);
  console.log(`project: ${config.projectDir}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal}: shutting down`);
    sessions.closeAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
