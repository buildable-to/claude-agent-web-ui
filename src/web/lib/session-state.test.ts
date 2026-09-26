import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HistoryMessage, ServerMessage, StoppedWorkNotice } from '@shared/protocol';
import { initialSessionState, sessionReducer, type SessionState } from './session-state';
import { applyHistory, applyMessage, CUT_TEXT, emptyTranscript, runningAgents, type Transcript } from './transcript';

const notice: StoppedWorkNotice = {
  id: 'stop-1', sessionId: 's', reason: 'service_stop',
  detectedAt: Date.UTC(2026, 8, 26, 14, 15), lastActiveAt: Date.UTC(2026, 8, 26, 14, 14),
};
const event = (state: SessionState, message: ServerMessage) => sessionReducer(state, { type: 'server', message });
const notes = (t: Transcript) => t.turns.filter((turn) => turn.kind === 'note');
const builders = (): Transcript => ({
  ...emptyTranscript(),
  turns: [{
    kind: 'assistant', id: 'a1', open: false,
    blocks: [{
      type: 'tool_use', id: 'builder', name: 'Agent', input: {},
      done: true, result: 'Async agent launched successfully', images: [], children: [],
      task: { status: 'running' },
    }],
  }],
});
const historyNotice = (value = notice): HistoryMessage => ({
  type: 'system', uuid: value.id, session_id: 's', message: null,
  parent_tool_use_id: null, stoppedWork: value,
});

test('a stopped builder is explained even though its coordinator finished, without starting a turn', () => {
  const state = { ...initialSessionState('s'), status: 'idle' as const, attached: true, transcript: builders() };
  const stopped = event(state, { type: 'work_stopped', sessionId: 's', notice });
  assert.equal(runningAgents(stopped.transcript), 0);
  assert.equal(stopped.attached, false);
  assert.equal(stopped.status, 'closed');
  assert.equal(notes(stopped.transcript).length, 1);
  assert.match(notes(stopped.transcript)[0]!.text, /Type "continue"/);
  const closed = event(stopped, { type: 'status', sessionId: 's', status: 'closed' });
  assert.equal(notes(closed.transcript).length, 1);
  assert.equal(closed.transcript.turns.some((turn) => turn.kind === 'user'), false);
});

test('history, reconnect, and repeated live delivery show one durable notice', () => {
  const loaded = applyHistory(builders(), [historyNotice()]);
  let state = sessionReducer(initialSessionState('s'), { type: 'history', transcript: loaded });
  state = event(state, { type: 'not_live', sessionId: 's', stoppedWork: [notice] });
  state = event(state, { type: 'not_live', sessionId: 's', stoppedWork: [notice] });
  state = event(state, { type: 'work_stopped', sessionId: 's', notice });
  assert.equal(notes(state.transcript).length, 1);
  assert.equal(runningAgents(state.transcript), 0);
  assert.equal(notes(state.transcript).some((turn) => turn.text === CUT_TEXT), false);
});

test('historical notices and their replay leave a resumed engine and its builders running', () => {
  const loaded = applyHistory(builders(), [historyNotice()]);
  assert.equal(runningAgents(loaded), 1, 'history is evidence, not a command to stop current tasks');
  let state = sessionReducer(initialSessionState('s'), { type: 'history', transcript: loaded });
  state = event(state, {
    type: 'attached', sessionId: 's', cwd: '/account', status: 'running',
    replay: [], pending: [], meta: {}, stoppedWork: [notice],
  });
  state = event(state, { type: 'work_stopped', sessionId: 's', notice });
  assert.equal(state.attached, true);
  assert.equal(state.status, 'running');
  assert.equal(runningAgents(state.transcript), 1);
  assert.equal(notes(state.transcript).length, 1);
});

test('a precise notice replaces a generic cut message delivered just before it', () => {
  const transcript = builders();
  const turn = transcript.turns[0];
  if (turn?.kind === 'assistant') turn.open = true;
  let state = { ...initialSessionState('s'), transcript };
  state = event(state, { type: 'status', sessionId: 's', status: 'closed' });
  assert.equal(notes(state.transcript)[0]?.text, CUT_TEXT);
  state = event(state, { type: 'work_stopped', sessionId: 's', notice });
  assert.equal(notes(state.transcript).length, 1);
  assert.notEqual(notes(state.transcript)[0]?.text, CUT_TEXT);
});

test('restart discovery describes observation time rather than inventing the crash time', () => {
  const t = applyHistory(emptyTranscript(), [historyNotice({ ...notice, reason: 'service_restart' })]);
  assert.match(notes(t)[0]?.text ?? '', /detected/i);
  assert.match(notes(t)[0]?.text ?? '', /last active/i);
  assert.doesNotMatch(notes(t)[0]?.text ?? '', /OOM/);
});

test('an older pending history response does not erase a new live interruption', () => {
  let state = event(initialSessionState('s'), { type: 'work_stopped', sessionId: 's', notice });
  state = sessionReducer(state, { type: 'history', transcript: builders() });
  assert.equal(notes(state.transcript).length, 1);
  assert.equal(runningAgents(state.transcript), 0);
  assert.equal(state.status, 'closed');
});

test('anchored historical incidents stop old tasks in order and preserve later resumed work', () => {
  const spawn = (uuid: string, toolId: string): HistoryMessage => ({
    type: 'assistant', uuid, session_id: 's', parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Agent', input: {} }] },
  });
  const launched = (uuid: string, toolId: string): HistoryMessage => ({
    type: 'user', uuid, session_id: 's', parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'Async agent launched successfully' }] },
  });
  const first = { ...notice, afterMessageUuid: 'old-launch' };
  const second = { ...first, id: 'stop-2', detectedAt: first.detectedAt + 1000 };
  let t = applyHistory(emptyTranscript(), [
    spawn('old', 'old-builder'), launched('old-launch', 'old-builder'),
    historyNotice(first), historyNotice(second),
    { type: 'user', uuid: 'continue', session_id: 's', parent_tool_use_id: null, message: { role: 'user', content: 'continue' } },
    spawn('new', 'new-builder'), launched('new-launch', 'new-builder'),
  ]);
  t = applyMessage(t, {
    type: 'system', subtype: 'task_started', uuid: '10000000-0000-4000-8000-000000000507',
    session_id: 's', task_id: 'new-task', tool_use_id: 'new-builder', description: 'The resumed builder',
  });
  assert.deepEqual(notes(t).map((turn) => turn.stoppedWork?.id), ['stop-1', 'stop-2']);
  assert.equal(runningAgents(t), 1, 'only the new builder is running');
  const tasks = t.turns.flatMap((turn) => turn.kind === 'assistant' ? turn.blocks : []);
  const old = tasks.find((block) => block.type === 'tool_use' && block.id === 'old-builder');
  const current = tasks.find((block) => block.type === 'tool_use' && block.id === 'new-builder');
  assert.equal(old?.type === 'tool_use' && old.task?.status, 'stopped');
  assert.equal(current?.type === 'tool_use' && current.task?.status, 'running');
});
