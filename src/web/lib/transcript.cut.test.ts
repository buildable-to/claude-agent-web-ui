import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HistoryMessage } from '@shared/protocol';
import { applyHistory, CUT_TEXT, emptyTranscript, endedMidTurn, markCut, type Turn } from './transcript';

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
