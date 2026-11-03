import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sessionTimes } from './session-manager.js';

test('a saved conversation says when each message was said, by uuid', () => {
  const home = mkdtempSync(join(tmpdir(), 'cfg-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const dir = join(home, 'projects', '-srv-agents-u1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's1.jsonl'), [
      JSON.stringify({ type: 'queue-operation', timestamp: '2026-11-03T10:00:00Z' }),
      JSON.stringify({ type: 'user', message: { content: '"uuid":"fake"' }, uuid: 'a', timestamp: '2026-11-03T10:00:01Z' }),
      JSON.stringify({ type: 'assistant', uuid: 'b', timestamp: '2026-11-03T10:00:09Z' }),
      '{"type":"assistant","uuid":"c","times',
    ].join('\n'));
    const times = sessionTimes('/srv/agents/u1', 's1');
    assert.deepEqual([...times], [['a', '2026-11-03T10:00:01Z'], ['b', '2026-11-03T10:00:09Z']]);
    assert.equal(sessionTimes('/srv/agents/u1', '../x').size, 0);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});
