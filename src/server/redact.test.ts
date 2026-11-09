import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SkillRedactor, redactHistory } from './redact.js';

const sdk = (m: unknown) => m as SDKMessage;
const said = (content: unknown[]) => sdk({ type: 'assistant', uuid: 'a', parent_tool_use_id: null, message: { role: 'assistant', content } });
const heard = (content: unknown, extra: object = {}) =>
  sdk({ type: 'user', uuid: 'u', parent_tool_use_id: null, message: { role: 'user', content }, ...extra });
const text = (m: SDKMessage | null) => JSON.stringify(m);

test("a skill loading reaches no page: its name, its text, its result", () => {
  const r = new SkillRedactor();
  const call = r.redact(said([{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'house-method' } }]));
  assert.ok(!text(call).includes('house-method'));
  const result = r.redact(heard([{ type: 'tool_result', tool_use_id: 't1', content: 'Launching skill: house-method' }],
    { tool_use_result: { commandName: 'house-method' } }));
  assert.ok(!text(result).includes('house-method'));
  const body = r.redact(heard([{ type: 'text', text: 'Base directory for this skill: /home/agent/.claude/skills/house-method\n\nThe secret rules.' }]));
  assert.ok(!text(body).includes('secret'));
  assert.ok(!text(r.redact(heard('Base directory for this skill: x\n\nThe secret rules.'))).includes('secret'));
});

test("the agent reading a skill's file becomes a bare skill step", () => {
  const r = new SkillRedactor();
  const call = r.redact(said([
    { type: 'text', text: 'Looking.' },
    { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/home/agent/.claude/skills/house-method/references/run.md' } },
    { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/srv/agents/a/scratch/look.md' } },
  ]));
  assert.ok(!text(call).includes('house-method') && text(call).includes('Looking.') && text(call).includes('look.md'));
  const result = r.redact(heard([
    { type: 'tool_result', tool_use_id: 't2', content: 'The secret rules.' },
    { type: 'tool_result', tool_use_id: 't3', content: 'the look' },
  ], { tool_use_result: { file: { content: 'The secret rules.' } } }));
  assert.ok(!text(result).includes('secret') && text(result).includes('the look'));
});

test('a streamed skill read stops before its name', () => {
  const r = new SkillRedactor();
  const ev = (event: object) => sdk({ type: 'stream_event', parent_tool_use_id: null, event });
  assert.ok(r.redact(ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Read', input: {} } })));
  assert.ok(r.redact(ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path": "\\/home\\/agent\\/.cla' } })));
  assert.equal(r.redact(ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ude\\/skills\\/house-method' } })), null);
  assert.equal(r.redact(ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '\\/SKILL.md"}' } })), null);
  assert.ok(r.redact(ev({ type: 'content_block_stop', index: 1 })));
  assert.ok(r.redact(ev({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', name: 'Skill', input: {} } })));
  assert.equal(r.redact(ev({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"skill":"house-method"}' } })), null);
  const words = ev({ type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'hi' } });
  assert.equal(r.redact(words), words);
});

test('history is read back the same way', () => {
  const got = redactHistory([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'h1', name: 'Bash', input: { command: 'cat ~/.claude/skills/house-method/SKILL.md' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'h1', content: 'The secret rules.' }] } },
    { type: 'user', message: { role: 'user', content: 'Draw it.' } },
  ]);
  assert.ok(!JSON.stringify(got).includes('secret') && !JSON.stringify(got).includes('house-method'));
  assert.equal((got[2]!.message as { content: string }).content, 'Draw it.');
});
