// SDK transport fixture: speaks the CLI wire protocol, never starts Claude or
// contacts a model. Its workers are real OS descendants, with observable exits.
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { appendFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const [directory, sessionId] = process.argv.slice(2);
const workers = new Map();
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const event = (message) => send({ type: 'system', uuid: randomUUID(), session_id: sessionId, ...message });
const log = (message) => appendFileSync(join(directory, 'engine.log'), `${message}\n`);
writeFileSync(join(directory, 'engine.pid'), String(process.pid));

async function stop(id) {
  const child = workers.get(id);
  if (!child) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
  workers.delete(id);
  log(`stopped ${id}`);
}

const lines = createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    const request = message.request;
    log(`control ${request.subtype}`);
    if (request.subtype === 'stop_task') await stop(request.task_id);
    send({ type: 'control_response', response: {
      subtype: 'success', request_id: message.request_id,
      response: { commands: [], models: [] },
    } });
    return;
  }
  if (message.type !== 'user') return;
  log(`prompt ${message.message.content}`);
  if (workers.size) return;
  for (let index = 0; index < 2; index++) {
    const id = `builder-${index}`;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    workers.set(id, child);
    writeFileSync(join(directory, `${id}.pid`), String(child.pid));
  }
  event({ subtype: 'background_tasks_changed', tasks: [...workers.keys()].map((task_id) => ({
    task_id, task_type: 'agent', description: 'Inert builder', ambient: false,
  })) });
  event({ subtype: 'session_state_changed', state: 'idle' });
});

lines.on('close', async () => {
  log('stdin closed');
  await Promise.all([...workers.keys()].map(stop));
  process.exit(0);
});
