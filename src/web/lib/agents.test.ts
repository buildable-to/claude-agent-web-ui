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
  assert.equal(fmtElapsed(41000), '41s');
  assert.equal(fmtElapsed(102000), '1m 42s');
});
