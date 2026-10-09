import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { forReplay, replaySince } from './replay.js';

const msg = (m: Record<string, unknown>) => ({ session_id: 's', parent_tool_use_id: null, ...m }) as unknown as SDKMessage;
const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(1000) } };
const said = (uuid: string, parent: string | null = null) =>
  msg({ type: 'assistant', uuid, parent_tool_use_id: parent, message: { role: 'assistant', content: [{ type: 'text', text: uuid }] } });
const answered = (uuid: string, parent: string | null = null) =>
  msg({
    type: 'user', uuid, parent_tool_use_id: parent, tool_use_result: { big: 'x'.repeat(1000) },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${uuid}`, content: [{ type: 'text', text: 'ok' }, png] }] },
  });
const note = (uuid: string) => msg({ type: 'system', subtype: 'task_progress', uuid, tool_use_id: 'agent' });
const content = (m: SDKMessage) => (m as unknown as { message: { content: Array<Record<string, any>> } }).message.content;

test("a helper's pictures keep their place and lose their bytes; the main conversation's keep both", () => {
  const helper = forReplay(answered('h', 'agent'));
  const picture = content(helper)[0]!.content[1];
  assert.equal(picture.type, 'image');
  assert.equal(picture.source.media_type, 'image/png');
  assert.equal(picture.source.data, '');
  assert.equal(content(helper)[0]!.content[0].text, 'ok');
  assert.equal(content(forReplay(answered('m')))[0]!.content[1].source.data.length, 1000);
});

test('the structured tool output is dropped everywhere; the original is untouched', () => {
  const original = answered('h', 'agent');
  assert.equal('tool_use_result' in forReplay(original), false);
  assert.equal('tool_use_result' in forReplay(answered('m')), false);
  assert.equal('tool_use_result' in original, true);
  assert.equal(content(original)[0]!.content[1].source.data.length, 1000);
});

test("a helper's thinking is dropped; its words and steps stay", () => {
  const helper = forReplay(msg({
    type: 'assistant', uuid: 'h', parent_tool_use_id: 'agent',
    message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'long', signature: 's' },
      { type: 'redacted_thinking', data: 'x' },
      { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } },
    ] },
  }));
  assert.deepEqual(content(helper).map((b) => b.type), ['tool_use']);
});

test('other messages pass through as they are', () => {
  const n = note('n1');
  assert.equal(forReplay(n), n);
});

test('the main conversation is replayed only after the newest message the page has', () => {
  const buffer = [said('a1'), answered('u1'), note('n1'), said('h1', 'agent'), said('a2'), answered('u2'), said('a3')];
  const ids = (ms: SDKMessage[]) => ms.map((m) => m.uuid);
  // the engineer's own words are never in the buffer: the search walks past them
  assert.deepEqual(ids(replaySince(buffer, ['a1', 'u1', 'a2', 'typed-by-engineer'])), ['n1', 'h1', 'u2', 'a3']);
  assert.deepEqual(ids(replaySince(buffer, ['a3'])), ['n1', 'h1']);
});

test('a page that knows nothing in the buffer gets all of it', () => {
  const buffer = [said('a1'), note('n1'), said('h1', 'agent')];
  assert.deepEqual(replaySince(buffer, undefined), buffer);
  assert.deepEqual(replaySince(buffer, []), buffer);
  assert.deepEqual(replaySince(buffer, ['from-before-this-engine']), buffer);
});

test("a helper's uuid never counts as known: helpers are in no history", () => {
  const buffer = [said('a1'), said('h1', 'agent'), said('a2')];
  assert.deepEqual(replaySince(buffer, ['h1']).map((m) => m.uuid), ['a1', 'h1', 'a2']);
});
