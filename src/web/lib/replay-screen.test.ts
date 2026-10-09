// The slim replay must draw the same screen as the full one: the page skips
// by uuid what history already showed, and never draws a helper's pictures.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HistoryMessage, SDKMessage, ServerMessage } from '@shared/protocol';
import { forReplay, replaySince } from '../../server/replay';
import { rememberKnown } from './known';
import { initialSessionState, sessionReducer } from './session-state';
import { applyHistory, emptyTranscript, type Transcript } from './transcript';

const png = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
const m = (x: Record<string, unknown>) => ({ session_id: 's', parent_tool_use_id: null, ...x }) as unknown as SDKMessage;
const assistant = (uuid: string, content: unknown[], parent: string | null = null) =>
  m({ type: 'assistant', uuid, parent_tool_use_id: parent, message: { role: 'assistant', content } });
const result = (uuid: string, toolId: string, content: unknown[], parent: string | null = null) =>
  m({
    type: 'user', uuid, parent_tool_use_id: parent, tool_use_result: { stdout: 'x'.repeat(100) },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content }] },
  });

// A turn that sent a helper off, looked at a picture itself, and is still going.
const a1 = assistant('a1', [{ type: 'tool_use', id: 'agent', name: 'Agent', input: { description: 'Draw the columns', prompt: 'p' } }]);
const u1 = result('u1', 'agent', [{ type: 'text', text: 'Async agent launched successfully' }]);
const h1 = assistant('h1', [
  { type: 'thinking', thinking: 'hm', signature: 's' },
  { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'perceive' } },
], 'agent');
const h2 = result('h2', 'b1', [{ type: 'text', text: 'sheet ok' }, png('HELPER-PICTURE')], 'agent');
const n1 = m({ type: 'system', subtype: 'task_progress', uuid: 'n1', tool_use_id: 'agent', summary: 'on the columns', usage: { tool_uses: 1 } });
const a2 = assistant('a2', [{ type: 'tool_use', id: 'look', name: 'Read', input: { file_path: 'sheet.png' } }]);
const u2 = result('u2', 'look', [png('MAIN-PICTURE')]);
const a3 = assistant('a3', [{ type: 'text', text: 'The columns are on their way.' }]);
const buffer = [a1, u1, h1, h2, n1, a2, u2, a3];

const asHistory = (x: SDKMessage): HistoryMessage => {
  const r = x as unknown as HistoryMessage;
  return { type: r.type, uuid: r.uuid, session_id: 's', message: r.message, parent_tool_use_id: r.parent_tool_use_id };
};
// The session file when the page opened: the engineer's words (never in the
// buffer), then the main conversation as far as a2.
const history: HistoryMessage[] = [
  { type: 'user', uuid: 'q1', session_id: 's', parent_tool_use_id: null, message: { role: 'user', content: 'Draw the columns' } },
  ...[a1, u1, a2].map(asHistory),
];

function screen(replay: SDKMessage[]): Transcript {
  let state = sessionReducer(initialSessionState('s'), { type: 'history', transcript: applyHistory(emptyTranscript(), history) });
  const attached: ServerMessage = { type: 'attached', sessionId: 's', cwd: '/a', status: 'running', replay, pending: [], meta: {}, stoppedWork: [] };
  state = sessionReducer(state, { type: 'server', message: attached });
  return state.transcript;
}

/** What the page draws: the turns, with a helper's picture bytes left out
 *  (only their count is ever shown). */
function drawn(t: Transcript) {
  return t.turns.map((turn) => turn.kind !== 'assistant' ? turn : {
    ...turn,
    blocks: turn.blocks.map((b) => b.type !== 'tool_use' ? b : {
      ...b,
      children: b.children.map((c) => ({ ...c, images: c.images.map((i) => ({ ...i, data: '' })) })),
    }),
  });
}

test('the slim replay draws the same screen as the full one', () => {
  const full = screen(buffer);
  const slim = screen(replaySince(buffer.map(forReplay), rememberKnown([], history)));
  assert.deepEqual(drawn(slim), drawn(full));
});

test('what the slim replay keeps: helper steps and pictures counted, the main picture whole', () => {
  const slim = screen(replaySince(buffer.map(forReplay), rememberKnown([], history)));
  const turn = slim.turns.find((t) => t.kind === 'assistant');
  assert.ok(turn && turn.kind === 'assistant');
  const agent = turn.blocks.find((b) => b.type === 'tool_use' && b.id === 'agent');
  assert.ok(agent && agent.type === 'tool_use');
  assert.equal(agent.task?.summary, 'on the columns');
  assert.equal(agent.children.length, 1);
  assert.equal(agent.children[0]!.result, 'sheet ok');
  assert.equal(agent.children[0]!.images.length, 1);
  const look = turn.blocks.find((b) => b.type === 'tool_use' && b.id === 'look');
  assert.ok(look && look.type === 'tool_use');
  assert.equal(look.images[0]!.data, 'MAIN-PICTURE');
});

test('the slim replay is a fraction of the full one', () => {
  const size = (ms: SDKMessage[]) => JSON.stringify(ms).length;
  const slim = replaySince(buffer.map(forReplay), rememberKnown([], history));
  assert.deepEqual(slim.map((x) => x.uuid), ['h1', 'h2', 'n1', 'u2', 'a3']);
  assert.ok(size(slim) < size(buffer));
});
