import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HistoryMessage, SDKMessage } from '@shared/protocol';
import {
  addLocalUserTurn,
  applyHistory,
  applyMessage,
  emptyTranscript,
  currentStep,
  CUT_TEXT,
  markCut,
  NO_RESPONSE,
  type Block,
  type ToolBlock,
  type Transcript,
  type Turn,
} from './transcript';

const hist = (type: HistoryMessage['type'], uuid: string, message: unknown): HistoryMessage => ({
  type,
  uuid,
  session_id: 's',
  message,
  parent_tool_use_id: null,
});
const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
const assistantTurn = (t: Transcript, i: number) => t.turns[i] as Extract<Turn, { kind: 'assistant' }>;
const live = (m: Record<string, unknown>) => ({ session_id: 's', parent_tool_use_id: null, ...m }) as unknown as SDKMessage;
const stream = (uuid: string, event: Record<string, unknown>) => live({ type: 'stream_event', uuid, event });

test('reloaded: thinking dropped, the picture kept, the command shown as the engineer’s words', () => {
  const t = applyHistory(emptyTranscript(), [
    hist('user', 'u1', { role: 'user', content: 'these beams are clashing' }),
    hist('assistant', 'a1', { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'x' }] }),
    hist('assistant', 'a2', {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x/3d_iso.png' } }],
    }),
    hist('user', 'u2', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [png] }] }),
    hist('assistant', 'a3', { role: 'assistant', content: [{ type: 'text', text: NO_RESPONSE }] }),
    hist('user', 'u3', {
      role: 'user',
      content: '<command-name>/usage</command-name><command-message>usage</command-message><command-args></command-args>',
    }),
  ]);
  assert.deepEqual(
    t.turns.map((x) => x.kind),
    ['user', 'assistant', 'user'],
  );
  const a = assistantTurn(t, 1);
  assert.equal(a.open, false);
  assert.deepEqual(
    a.blocks.map((b) => b.type),
    ['tool_use', 'text'],
  );
  const tool = a.blocks[0] as ToolBlock;
  assert.equal(tool.images.length, 1);
  assert.equal(tool.images[0]!.mediaType, 'image/png');
  assert.equal(tool.result, '');
  assert.equal((t.turns[2] as Extract<Turn, { kind: 'user' }>).text, '/usage');
});

test('a note after the agent’s last words does not keep the turn open (no forever cursor)', () => {
  const t = applyHistory(emptyTranscript(), [
    hist('user', 'u1', { role: 'user', content: 'hi' }),
    hist('assistant', 'a1', { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] }),
    hist('user', 'u2', { role: 'user', content: '[Request interrupted by user]' }),
  ]);
  assert.deepEqual(
    t.turns.map((x) => x.kind),
    ['user', 'assistant', 'note'],
  );
  assert.equal(assistantTurn(t, 1).open, false);
});

test('live: streamed thinking is skipped on both paths, so the final blocks land in place', () => {
  let t = emptyTranscript();
  t = addLocalUserTurn(t, 'local', 'look');
  t = applyMessage(t, stream('m', { type: 'message_start' }));
  t = applyMessage(t, stream('m', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
  t = applyMessage(t, stream('m', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me' } }));
  t = applyMessage(t, stream('m', { type: 'content_block_stop', index: 0 }));
  t = applyMessage(t, stream('m', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Read', input: {} } }));
  t = applyMessage(t, stream('m', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a.png"}' } }));
  t = applyMessage(t, stream('m', { type: 'content_block_stop', index: 1 }));
  t = applyMessage(t, stream('m', { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }));
  t = applyMessage(t, stream('m', { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Done' } }));
  t = applyMessage(t, stream('m', { type: 'content_block_stop', index: 2 }));
  // the engine then sends each finished block as its own assistant message
  t = applyMessage(t, live({ type: 'assistant', uuid: 'f0', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'let me', signature: 's' }] } }));
  t = applyMessage(t, live({ type: 'assistant', uuid: 'f1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.png' } }] } }));
  t = applyMessage(t, live({ type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [png] }] } }));
  t = applyMessage(t, live({ type: 'assistant', uuid: 'f2', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }));
  t = applyMessage(t, live({ type: 'result', uuid: 'res', subtype: 'success', is_error: false, result: 'Done.' }));
  assert.deepEqual(
    t.turns.map((x) => x.kind),
    ['user', 'assistant'],
  );
  const a = assistantTurn(t, 1);
  assert.equal(a.open, false);
  assert.deepEqual(
    a.blocks.map((b) => b.type),
    ['tool_use', 'text'],
  );
  assert.equal((a.blocks[1] as { text: string }).text, 'Done.');
  assert.equal((a.blocks[0] as ToolBlock).images.length, 1);
  assert.deepEqual((a.blocks[0] as ToolBlock).input, { file_path: '/a.png' });
});

test('the page’s echo of a slash command and the engine’s record of it show once', () => {
  let t = addLocalUserTurn(emptyTranscript(), 'local', '/compose-project fix the beams');
  t = applyMessage(
    t,
    live({
      type: 'user',
      uuid: 'engine-uuid',
      message: {
        role: 'user',
        content:
          '<command-name>/compose-project</command-name><command-message>compose-project</command-message><command-args>fix the beams</command-args>',
      },
    }),
  );
  assert.equal(t.turns.length, 1);
  assert.equal((t.turns[0] as Extract<Turn, { kind: 'user' }>).text, '/compose-project fix the beams');
});

test('live: a skill’s text and other injected context are not the engineer speaking; an interruption is a note', () => {
  let t = addLocalUserTurn(emptyTranscript(), 'local', 'what is this project about?');
  t = applyMessage(
    t,
    live({
      type: 'user',
      uuid: 'skill-text',
      isSynthetic: true,
      message: { role: 'user', content: 'Base directory for this skill: /x/.claude/skills/compose-project\n\n# Compose a project' },
    }),
  );
  t = applyMessage(
    t,
    live({ type: 'user', uuid: 'unflagged', message: { role: 'user', content: 'Base directory for this skill: /y\n\n# Another' } }),
  );
  t = applyMessage(
    t,
    live({ type: 'user', uuid: 'stop', isSynthetic: true, message: { role: 'user', content: '[Request interrupted by user]' } }),
  );
  assert.deepEqual(
    t.turns.map((x) => x.kind),
    ['user', 'note'],
  );
  assert.equal((t.turns[1] as Extract<Turn, { kind: 'note' }>).text, 'Request interrupted by user');
});

test('the current step is the open turn\'s newest unanswered visible call', () => {
  const tool = (id: string, name: string, result?: string) => ({
    type: 'tool_use' as const, id, name, input: {}, done: true, images: [], children: [],
    ...(result !== undefined ? { result } : {}),
  });
  const turnOf = (open: boolean, blocks: Block[]): Transcript => ({
    ...emptyTranscript(), turns: [{ kind: 'assistant', id: 'a', open, blocks }],
  });
  assert.equal(currentStep(turnOf(true, [tool('1', 'Bash', 'ok')])), null, 'every step answered: thinking');
  assert.equal(currentStep(turnOf(true, [tool('1', 'Bash', 'ok'), tool('2', 'Bash')]))?.id, '2');
  assert.equal(currentStep(turnOf(true, [tool('1', 'Bash'), tool('2', 'Skill')]))?.id, '1', 'a skill loading is not a step');
  assert.equal(currentStep(turnOf(false, [tool('1', 'Bash')])), null, 'a closed turn is not at work');
  const agent = { ...tool('7', 'Agent', 'Async agent launched successfully'), task: { status: 'running' as const } };
  assert.equal(currentStep(turnOf(false, [agent]))?.id, '7', 'a sub-agent outlives the turn that sent it');
  assert.equal(currentStep(turnOf(false, [{ ...agent, task: { status: 'completed' as const } }])), null);
  const backgrounded = { ...tool('1', 'Bash', 'Command running in background'), task: { status: 'running' as const } };
  assert.equal(currentStep(turnOf(true, [backgrounded]))?.id, '1', 'a backgrounded command is still the step');
  const withNote: Transcript = {
    ...turnOf(true, [tool('1', 'Read')]),
    turns: [...turnOf(true, [tool('1', 'Read')]).turns, { kind: 'note', id: 'n', level: 'info', text: 'compacted' }],
  };
  assert.equal(currentStep(withNote)?.id, '1', 'a note does not hide the step');
});

test('a follow-up sent mid-turn does not mark the running step done; the next words close it', () => {
  const running: Transcript = {
    ...emptyTranscript(),
    turns: [{ kind: 'assistant', id: 'a', open: true, blocks: [
      { type: 'tool_use', id: 'render', name: 'Bash', input: {}, done: true, images: [], children: [] },
    ] }],
  };
  const followed = addLocalUserTurn(running, 'u1', 'also check the beams');
  assert.equal(assistantTurn(followed, 0).open, true, 'the step is still running');
  assert.equal(followed.turns[1]!.kind, 'user');
  assert.equal(currentStep(followed)?.id, 'render', 'the work line keeps naming it');
  const next = applyMessage(followed, live({ type: 'assistant', uuid: 'm2', message: { id: 'msg2', role: 'assistant', content: [{ type: 'text', text: 'Now the beams.' }] } }));
  assert.equal(assistantTurn(next, 0).open, false, 'the engine spoke after the follow-up: the old turn is done');
  assert.equal(assistantTurn(next, 2).open, true);
});

test('an engine that dies under a follow-up sent mid-turn closes the turn above it and says so', () => {
  const running: Transcript = {
    ...emptyTranscript(),
    turns: [{ kind: 'assistant', id: 'a', open: true, blocks: [
      { type: 'tool_use', id: 'render', name: 'Bash', input: {}, done: true, images: [], children: [] },
    ] }],
  };
  const cut = markCut(addLocalUserTurn(running, 'u1', 'also the beams'), 'cut-1');
  assert.equal(assistantTurn(cut, 0).open, false);
  assert.ok(cut.turns.some((x) => x.kind === 'note' && x.text === CUT_TEXT));
});
