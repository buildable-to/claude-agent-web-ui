import assert from 'node:assert/strict';
import test from 'node:test';
import type { PermissionRequest } from '@shared/protocol';
import { questionText, turnError } from './notify';
import { addNote, emptyTranscript } from './transcript';

const req = (over: Partial<PermissionRequest>): PermissionRequest => ({
  requestId: 'r', toolUseId: 't', toolName: 'Write', input: {}, canAlwaysAllow: false, createdAt: 0, ...over,
});

test('a question card says its first question', () => {
  const ask = req({ toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which  column\nheight?' }, { question: 'b' }] } });
  assert.equal(questionText([ask]), 'Which column height?');
});

test('an approve card says the engine sentence, else the tool', () => {
  assert.equal(questionText([req({ title: 'Claude wants to write a.txt' })]), 'Claude wants to write a.txt');
  assert.equal(questionText([req({})]), 'Allow Write?');
  assert.equal(questionText([]), null);
});

test('a turn that ended on an error says it; any other end does not', () => {
  const t = addNote(emptyTranscript(), 'e1', 'error', 'The turn ended with an error.');
  assert.equal(turnError(t), 'The turn ended with an error.');
  assert.equal(turnError(addNote(t, 'i1', 'info', 'ok')), null);
  assert.equal(turnError(emptyTranscript()), null);
});
