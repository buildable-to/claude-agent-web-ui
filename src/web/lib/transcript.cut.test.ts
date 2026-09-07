import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HistoryMessage } from '@shared/protocol';
import { applyHistory, applyMessage, CUT_TEXT, emptyTranscript, endedMidTurn, markCut, reopenLastTurn, type Turn } from './transcript';

const hist = (type: HistoryMessage['type'], uuid: string, message: unknown): HistoryMessage => ({
  type,
  uuid,
  session_id: 's',
  message,
  parent_tool_use_id: null,
});

test('a conversation whose last turn ends in a tool call with no result was cut; marking it says so once', () => {
  const cut = applyHistory(emptyTranscript(), [
    hist('user', 'u1', { role: 'user', content: 'these beams are clashing' }),
    hist('assistant', 'a1', {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'python -m x', description: 'Revoke clash accept' } }],
    }),
  ]);
  assert.equal(endedMidTurn(cut), true);
  const marked = markCut(cut, 'cut-1');
  assert.deepEqual(
    marked.turns.map((x) => x.kind),
    ['user', 'assistant', 'note'],
  );
  assert.equal((marked.turns[2] as Extract<Turn, { kind: 'note' }>).text, CUT_TEXT);
  assert.equal((marked.turns[1] as Extract<Turn, { kind: 'assistant' }>).open, false);
  assert.equal(markCut(marked, 'cut-1').turns.length, 3);

  const finished = applyHistory(emptyTranscript(), [
    hist('user', 'u1', { role: 'user', content: 'hi' }),
    hist('assistant', 'a1', { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] }),
  ]);
  assert.equal(endedMidTurn(finished), false);
  assert.equal(markCut(finished, 'cut-2').turns.length, 2);
});

test('attaching mid-turn continues the last turn instead of starting a second one', () => {
  const fromHistory = applyHistory(emptyTranscript(), [
    hist('user', 'u1', { role: 'user', content: 'what elements do we have here?' }),
    hist('assistant', 'a1', {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls', description: 'List elements' } }],
    }),
    hist('user', 'u2', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'C1 C2' }] }),
  ]);
  assert.equal((fromHistory.turns[1] as Extract<Turn, { kind: 'assistant' }>).open, false);

  const reopened = reopenLastTurn(fromHistory);
  assert.equal((reopened.turns[1] as Extract<Turn, { kind: 'assistant' }>).open, true);
  // The engine's next message lands in the same turn.
  const next = applyMessage(reopened, {
    type: 'assistant',
    uuid: 'a2',
    session_id: 's',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'x', description: 'Describe corbel column' } }],
    },
  } as never);
  assert.equal(next.turns.length, 2);
  assert.equal((next.turns[1] as Extract<Turn, { kind: 'assistant' }>).blocks.length, 2);

  // A finished turn reopens too: the engine is running, so its next message continues it.
  const finished = applyHistory(emptyTranscript(), [
    hist('user', 'u1', { role: 'user', content: 'hi' }),
    hist('assistant', 'a1', { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] }),
  ]);
  assert.equal((reopenLastTurn(finished).turns[1] as Extract<Turn, { kind: 'assistant' }>).open, true);
  assert.equal(reopenLastTurn(emptyTranscript()).turns.length, 0);
});
