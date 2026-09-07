import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentName,
  agentType,
  findingLine,
  fmtElapsed,
  isFanOut,
  laneElapsed,
  laneState,
  noteLaneTime,
  resetLaneClock,
} from './agents';
import type { ToolBlock } from './transcript';

const task = (id: string, extra: Partial<ToolBlock> = {}, input: Record<string, unknown> = {}): ToolBlock => ({
  type: 'tool_use',
  id,
  name: 'Task',
  input: { description: `Research ${id}`, subagent_type: 'general-purpose', ...input },
  done: true,
  images: [],
  children: [],
  ...extra,
});
const bash = (id: string): ToolBlock => ({
  type: 'tool_use', id, name: 'Bash', input: { command: 'ls', description: 'List' }, done: true, images: [], children: [],
});

test('two sub-agents in one stretch of work is a fan-out; one is not', () => {
  assert.equal(isFanOut([bash('b'), task('a')]), false);
  assert.equal(isFanOut([task('a'), task('b')]), true);
  assert.equal(isFanOut([bash('b'), task('a'), task('c'), bash('d')]), true);
});

test('a lane is named by the agent\'s description; the default type is not a word', () => {
  assert.equal(agentName(task('F3', {}, { description: ' Research F3 fachwerk footing ' })), 'Research F3 fachwerk footing');
  assert.equal(agentName(task('x', {}, { description: '' })), 'Sub-agent');
  assert.equal(agentType(task('x')), undefined);
  assert.equal(agentType(task('x', {}, { subagent_type: 'Explore' })), 'Explore');
});

test('lane state: running only while the turn is live; an error is failed', () => {
  assert.equal(laneState(task('a'), true), 'running');
  assert.equal(laneState(task('a'), false), 'done');
  assert.equal(laneState(task('a', { result: 'ok' }), true), 'done');
  assert.equal(laneState(task('a', { result: 'boom', isError: true }), true), 'failed');
});

test('the finding line is the first non-empty line, unmarked, cut to one row', () => {
  assert.equal(findingLine('\n\n## E5 roof purlin\n96 pieces'), 'E5 roof purlin');
  assert.equal(findingLine('- **96 pieces**, two lengths'), '96 pieces, two lengths');
  assert.equal(findingLine(''), undefined);
  assert.equal(findingLine('x'.repeat(200), 20), 'x'.repeat(19) + '…');
});

test('lane time comes from the browser clock, never from the transcript', () => {
  resetLaneClock();
  const a = task('a');
  assert.equal(laneElapsed(a, 1000), undefined);
  noteLaneTime(a, 1000);
  assert.equal(laneElapsed(a, 4000), 3000);
  noteLaneTime({ ...a, result: 'found' }, 6000);
  assert.equal(laneElapsed(a, 9000), 5000);
  // A lane first seen already finished (history, replay) gets no time.
  const late = task('late', { result: 'found' });
  assert.equal(noteLaneTime(late, 1000), undefined);
  assert.equal(laneElapsed(late, 2000), undefined);
  assert.equal(fmtElapsed(41000), '41s');
  assert.equal(fmtElapsed(102000), '1m 42s');
});

test('a backgrounded sub-agent runs until the engine says it settled; its finding is the summary', async () => {
  const { applyMessage, emptyTranscript, isInFlight, runningAgents } = await import('./transcript');
  const { finding, laneState, laneLine } = await import('./agents');
  const sys = (subtype: string, extra: Record<string, unknown>) =>
    ({ type: 'system', subtype, uuid: `${subtype}-${Math.random()}`, session_id: 's', tool_use_id: 't1', ...extra }) as never;
  let t = applyMessage(emptyTranscript(), {
    type: 'assistant',
    uuid: 'a1',
    session_id: 's',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Beams note', subagent_type: 'general-purpose' } }],
    },
  } as never);
  t = applyMessage(t, sys('task_started', { task_id: 'k1', description: 'Beams note' }));
  // The placeholder result lands: still running.
  t = applyMessage(t, {
    type: 'user',
    uuid: 'u1',
    session_id: 's',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Async agent launched successfully. (internal)' }] },
  } as never);
  const block = () => {
    const turn = t.turns[0];
    if (turn?.kind !== 'assistant') throw new Error('no turn');
    const b = turn.blocks[0];
    if (b?.type !== 'tool_use') throw new Error('no block');
    return b;
  };
  assert.equal(isInFlight(block()), true);
  assert.equal(laneState(block(), false), 'running');
  assert.equal(finding(block()), undefined);
  assert.equal(runningAgents(t), 1);

  t = applyMessage(t, sys('task_progress', { task_id: 'k1', description: 'Beams note', usage: { total_tokens: 900, tool_uses: 2, duration_ms: 4000 }, last_tool_name: 'Bash', summary: 'Writing the note' }));
  assert.equal(laneLine(block()), 'Writing the note');

  t = applyMessage(t, sys('task_notification', { task_id: 'k1', status: 'completed', output_file: '/x', summary: 'beams: 16 pieces', usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 21000 } }));
  assert.equal(isInFlight(block()), false);
  assert.equal(laneState(block(), false), 'done');
  assert.equal(finding(block()), 'beams: 16 pieces');
  assert.equal(block().task?.durationMs, 21000);
  assert.equal(runningAgents(t), 0);

  // Housekeeping tasks the engine hides never touch a lane.
  const before = t;
  t = applyMessage(t, sys('task_started', { task_id: 'k2', description: 'watch', ambient: true }));
  assert.deepEqual(t.turns, before.turns);
});

test('the recorded <task-notification> is the lane’s finding after a reload, not the engineer’s words', async () => {
  const { applyHistory, emptyTranscript } = await import('./transcript');
  const { finding, laneState } = await import('./agents');
  const hist = (type: 'user' | 'assistant', uuid: string, message: unknown) =>
    ({ type, uuid, session_id: 's', message, parent_tool_use_id: null }) as never;
  const t = applyHistory(emptyTranscript(), [
    hist('user', 'u1', { role: 'user', content: 'fan out' }),
    hist('assistant', 'a1', {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Beams note', subagent_type: 'general-purpose' } }],
    }),
    hist('user', 'u2', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Async agent launched successfully. (internal)' }] }),
    hist('assistant', 'a2', { role: 'assistant', content: [{ type: 'text', text: 'Waiting.' }] }),
    hist('user', 'u3', {
      role: 'user',
      content:
        '<task-notification>\n<task-id>k1</task-id>\n<tool-use-id>t1</tool-use-id>\n<status>completed</status>\n<summary>Agent "Beams note" finished</summary>\n<result>beams: 37 pieces</result>\n<usage><subagent_tokens>12363</subagent_tokens><tool_uses>3</tool_uses><duration_ms>89480</duration_ms></usage>\n</task-notification>',
    }),
    hist('assistant', 'a3', { role: 'assistant', content: [{ type: 'text', text: 'Beams is done.' }] }),
  ]);
  assert.deepEqual(
    t.turns.map((x) => x.kind),
    ['user', 'assistant', 'assistant'],
  );
  const turn = t.turns[1];
  if (turn?.kind !== 'assistant' || turn.blocks[0]?.type !== 'tool_use') throw new Error('shape');
  const b = turn.blocks[0];
  assert.equal(laneState(b, false), 'done');
  assert.equal(finding(b), 'beams: 37 pieces');
  assert.equal(b.task?.durationMs, 89480);
  assert.equal(b.task?.toolUses, 3);
});
