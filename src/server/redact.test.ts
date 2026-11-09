import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SkillRedactor, hiddenSkills, redactHistory } from './redact.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HIDDEN = new Set(['house-method']);

const sdk = (m: unknown) => m as SDKMessage;
const said = (content: unknown[]) => sdk({ type: 'assistant', uuid: 'a', parent_tool_use_id: null, message: { role: 'assistant', content } });
const heard = (content: unknown, extra: object = {}) =>
  sdk({ type: 'user', uuid: 'u', parent_tool_use_id: null, message: { role: 'user', content }, ...extra });
const text = (m: SDKMessage | null) => JSON.stringify(m);

test("a skill loading reaches no page: its name, its text, its result", () => {
  const r = new SkillRedactor(HIDDEN);
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
  const r = new SkillRedactor(HIDDEN);
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
  const r = new SkillRedactor(HIDDEN);
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
  ], HIDDEN);
  assert.ok(!JSON.stringify(got).includes('secret') && !JSON.stringify(got).includes('house-method'));
  assert.equal((got[2]!.message as { content: string }).content, 'Draw it.');
});

test("a helper keeps its card; a brief carrying the method is not sent", () => {
  const r = new SkillRedactor(HIDDEN);
  const plain = said([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'Tidy elev', prompt: 'Read .claude/skills/edit-drawing/SKILL.md first.' } }]);
  assert.equal(r.redact(plain), plain);
  const ours = r.redact(said([{ type: 'tool_use', id: 'a2', name: 'Agent', input: { description: 'Tidy sec', prompt: 'Load house-method. Its thirteen tests: ...' } }]));
  assert.ok(text(ours).includes('Tidy sec') && text(ours).includes('"name":"Agent"') && !text(ours).includes('thirteen'));
  const first = r.redact(sdk({ type: 'user', uuid: 'h', parent_tool_use_id: 'a2', message: { role: 'user', content: [{ type: 'text', text: 'Load house-method. Its thirteen tests' }] } }));
  assert.ok(!text(first).includes('thirteen'));
  const started = r.redact(sdk({ type: 'system', subtype: 'task_started', task_id: 't', description: 'Tidy sec', prompt: 'Load house-method. Its thirteen tests' }));
  assert.ok(!text(started).includes('thirteen') && text(started).includes('Tidy sec'));
});

test('the skills folder as a whole, or a hidden skill named in a command, is a skill step', () => {
  const r = new SkillRedactor(HIDDEN);
  for (const input of [{ pattern: 'x', path: '/home/agent/.claude/skills' }, { command: 'ls ~/.claude/skills' },
    { command: 'cd ~/.claude/skills && cat house-method/SKILL.md' }]) {
    const got = r.redact(said([{ type: 'tool_use', id: 'g', name: 'Bash', input }]));
    assert.ok(text(got).includes('"name":"Skill"') && !text(got).includes('skills'), JSON.stringify(input));
  }
});

test("a hidden skill's name left in a reply or a printout reads 'drawing standard'", () => {
  const r = new SkillRedactor(HIDDEN);
  const got = r.redact(said([{ type: 'text', text: 'Ran house-method on the elevation.' }]));
  assert.ok(text(got).includes('Ran drawing standard on'));
  const out = r.redact(heard([{ type: 'tool_result', tool_use_id: 'z', content: 'a value in its style (house-method)' }]));
  assert.ok(!text(out).includes('house-method'));
});

test('the hidden skills are those that say user-invocable: false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'home-'));
  for (const [name, head] of [['ours', 'user-invocable: false\n'], ['theirs', '']]) {
    await mkdir(join(dir, 'skills', name!), { recursive: true });
    await writeFile(join(dir, 'skills', name!, 'SKILL.md'), `---\nname: ${name}\n${head}description: x\n---\nbody`);
  }
  assert.deepEqual([...hiddenSkills(dir)], ['ours']);
});

test('streamed, a name split over two pieces never goes out, nor a helper brief', () => {
  const r = new SkillRedactor(HIDDEN, new Set());
  const ev = (event: object) => sdk({ type: 'stream_event', parent_tool_use_id: null, event });
  const piece = (index: number, t: string) => r.redact(ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } }));
  r.redact(ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  const sent = [piece(0, 'I will run house-'), piece(0, 'method now')].map((m) => text(m)).join('');
  assert.ok(!sent.includes('house') && sent.includes('drawing standard'));
  r.redact(ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Agent', input: {} } }));
  assert.equal(r.redact(ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"prompt":"thirteen tests' } })), null);
});

test("a helper's lane lines and the engineer's own words", () => {
  const r = new SkillRedactor(HIDDEN, new Set());
  const lane = r.redact(sdk({ type: 'system', subtype: 'task_progress', task_id: 't', description: 'house-method pass, box elev', summary: 'Ran house-method test 5' }));
  assert.ok(!text(lane).includes('house-method'));
  const theirs = heard('What is house-method?');
  assert.equal(r.redact(theirs), theirs);
});

test('a wildcard read is a skill step; a note written is still a Write', () => {
  const r = new SkillRedactor(HIDDEN, new Set(['edit-drawing']));
  const wild = r.redact(said([{ type: 'tool_use', id: 'w', name: 'Bash', input: { command: 'cat ~/.claude/skills/h*/SKILL.md' } }]));
  assert.ok(text(wild).includes('"name":"Skill"'));
  const shown = said([{ type: 'tool_use', id: 's', name: 'Read', input: { file_path: '/home/agent/.claude/skills/edit-drawing/SKILL.md' } }]);
  assert.equal(r.redact(shown), shown);
  const note = r.redact(said([{ type: 'tool_use', id: 'n', name: 'Write', input: { file_path: 'scratch/n.md', content: 'by house-method' } }]));
  assert.ok(text(note).includes('"name":"Write"') && !text(note).includes('house-method'));
});
