import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { ServerConfig } from '../shared/protocol.js';
import { loadConfig, projectName } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
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

// In production the built web app is served from the same port.
const webDist = resolve(here, '../../web');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(resolve(webDist, 'index.html')));
}

const server = createServer(app);
server.listen(config.port, config.host, () => {
  console.log(`claude-agent-web-ui listening on http://${config.host}:${config.port}`);
  console.log(`project: ${config.projectDir}`);
});
