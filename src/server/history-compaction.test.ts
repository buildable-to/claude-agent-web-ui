import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionManager, rowsBeforeCompactions } from './session-manager.js';

const SESSION = '0e64d87c-3d35-44af-b4e2-6e3de366c946';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A conversation as the engine saves it: said in order, compacted where told. */
function transcript(steps: Array<'compact' | string>): string {
  const lines: string[] = [];
  let parent: string | null = null;
  let n = 0;
  const row = (extra: Record<string, unknown>) => {
    const uuid = id(++n);
    lines.push(JSON.stringify({
      parentUuid: parent, isSidechain: false, uuid, sessionId: SESSION,
      timestamp: `2026-11-11T08:00:${String(n).padStart(2, '0')}.000Z`, ...extra,
    }));
    parent = uuid;
  };
  for (const step of steps) {
    if (step === 'compact') {
      const before = parent;
      parent = null;
      row({ logicalParentUuid: before, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' });
      row({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued.' } });
    } else {
      row({ type: 'user', message: { role: 'user', content: step } });
      row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `re: ${step}` }] } });
    }
  }
  return lines.join('\n') + '\n';
}

function saved(steps: Array<'compact' | string>): () => void {
  const home = mkdtempSync(join(tmpdir(), 'cfg-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  const dir = join(home, 'projects', '-srv-agents-u1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SESSION}.jsonl`), transcript(steps));
  return () => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  };
}

const said = (history: Array<{ type: string; message: unknown }>) => history
  .filter((m) => m.type === 'user')
  .map((m) => (m.message as { content?: unknown }).content)
  .filter((c) => typeof c === 'string' && !c.startsWith('This session'));

test('history keeps what was said before a compaction, in order, once', async () => {
  const done = saved(['the excel', 'compact', 'the stairs', 'compact', 'the beams']);
  try {
    const history = await new SessionManager('/srv/agents/u1').history(SESSION);
    assert.deepEqual(said(history), ['the excel', 'the stairs', 'the beams']);
    assert.equal(new Set(history.map((m) => m.uuid)).size, history.length);
    assert.ok(history.every((m) => m.timestamp));
  } finally {
    done();
  }
});

test('a conversation never compacted is read once, as before', async () => {
  const done = saved(['the excel', 'the stairs']);
  try {
    assert.deepEqual(rowsBeforeCompactions('/srv/agents/u1', SESSION), []);
    assert.deepEqual(rowsBeforeCompactions('/srv/agents/u1', '../x'), []);
    assert.deepEqual(said(await new SessionManager('/srv/agents/u1').history(SESSION)), ['the excel', 'the stairs']);
  } finally {
    done();
  }
});
