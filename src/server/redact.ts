// What the agent reads of its own skills stays on the server (Buildable #1253).
//
// Some of the agent's skills are its own method, not the engineer's: a skill
// whose header says `user-invocable: false` (Claude Code's field: only the
// model loads it) — Buildable's drawing standard. The page already hid a skill
// loading as a step, but the engine's messages still carried the skill's whole
// text (the "Base directory for this skill" message) and whatever the agent
// read of it. Every message a page is sent — live, replayed, or read back from
// history — passes here first:
// - a skill loading, and a step whose input names a hidden skill or the
//   skills folder as a whole, becomes a bare `Skill` step (hidden by the page)
//   with no input and no result;
// - a helper's brief that names a hidden skill is not sent (the card stays);
// - the skill's text is dropped;
// - a hidden skill's name anywhere else reads "drawing standard".

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeConfigDir } from './commands.js';

type AnyRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is AnyRecord => typeof v === 'object' && v !== null && !Array.isArray(v);

const SKILL_TEXT = /^\s*Base directory for this skill:/;
/** the skills folder itself, not one skill in it (`ls ~/.claude/skills`) */
const SKILLS_FOLDER = /\.claude\\?\/skills(?!\\?\/[A-Za-z0-9])/;
const HELPERS = new Set(['Agent', 'Task']);
const NEUTRAL = 'drawing standard';

let cache: { at: number; names: ReadonlySet<string> } | null = null;

/** The hidden skills of the agent's Claude home, read again each minute. */
export function hiddenSkills(dir = claudeConfigDir()): ReadonlySet<string> {
  if (cache && Date.now() - cache.at < 60_000) return cache.names;
  const names = new Set<string>();
  try {
    for (const folder of readdirSync(join(dir, 'skills'))) {
      try {
        const head = /^---\s*\n([\s\S]*?)\n---/.exec(readFileSync(join(dir, 'skills', folder, 'SKILL.md'), 'utf8'))?.[1] ?? '';
        if (!/^user-invocable:\s*false\s*$/m.test(head)) continue;
        names.add(folder);
        const named = /^name:\s*(.+)$/m.exec(head)?.[1]?.trim().replace(/^["']|["']$/g, '');
        if (named) names.add(named);
      } catch {
        // not a skill
      }
    }
  } catch {
    // no skills folder
  }
  cache = { at: Date.now(), names };
  return names;
}

/** One conversation's filter; it remembers which steps were a skill's, so
 *  their results are dropped too. Feed it messages in the engine's order. */
export class SkillRedactor {
  private readonly steps = new Set<string>();
  /** a streamed tool call's input so far, by `<helper>:<block index>`;
   *  null once it is a skill's: its input is no longer sent */
  private readonly streaming = new Map<string, string | null>();
  private readonly names: RegExp | null;

  constructor(hidden: ReadonlySet<string> = hiddenSkills()) {
    const words = [...hidden].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    this.names = words.length ? new RegExp(`(?<![A-Za-z0-9-])(?:${words.join('|')})(?![A-Za-z0-9-])`, 'g') : null;
  }

  /** The message as a page may see it; null: send nothing. */
  redact(message: SDKMessage): SDKMessage | null {
    if (message.type === 'assistant') return this.renamed(this.assistant(message));
    if (message.type === 'user') return this.renamed(this.user(message));
    if (message.type === 'stream_event') return this.stream(message);
    if (message.type === 'system' && 'prompt' in message && this.named(String(message.prompt ?? ''))) {
      return { ...message, prompt: '' } as SDKMessage;
    }
    return message;
  }

  private named(text: string): boolean {
    if (!this.names) return false;
    this.names.lastIndex = 0;
    return this.names.test(text);
  }

  private secret(input: unknown): boolean {
    const text = JSON.stringify(input ?? {});
    return SKILLS_FOLDER.test(text) || this.named(text);
  }

  private assistant(message: Extract<SDKMessage, { type: 'assistant' }>): SDKMessage {
    const content = message.message.content;
    if (!Array.isArray(content)) return message;
    let changed = false;
    const out = content.map((b) => {
      if (b.type !== 'tool_use') return b;
      if (HELPERS.has(b.name)) {
        // the helper's card stays; a brief that carries the method does not
        const input = isRecord(b.input) ? b.input : {};
        if (!this.named(String(input.prompt ?? ''))) return b;
        changed = true;
        return { ...b, input: { ...input, prompt: '' } };
      }
      if (b.name !== 'Skill' && !this.secret(b.input)) return b;
      this.steps.add(b.id);
      changed = true;
      return { ...b, name: 'Skill', input: {} };
    });
    return changed ? withContent(message, out) : message;
  }

  private user(message: Extract<SDKMessage, { type: 'user' }>): SDKMessage {
    const content: unknown = message.message.content;
    // a helper's first words are its brief
    const brief = (text: string) => SKILL_TEXT.test(text) || (Boolean(message.parent_tool_use_id) && this.named(text));
    if (typeof content === 'string') return brief(content) ? withContent(message, '') : message;
    if (!Array.isArray(content)) return message;
    let changed = false;
    const out: unknown[] = [];
    for (const b of content) {
      if (isRecord(b) && b.type === 'text' && brief(String(b.text ?? ''))) {
        changed = true;
        continue;
      }
      if (isRecord(b) && b.type === 'tool_result' && this.steps.has(String(b.tool_use_id ?? ''))) {
        changed = true;
        out.push({ ...b, content: '' });
        continue;
      }
      out.push(b);
    }
    if (!changed) return message;
    const { tool_use_result: _dropped, ...rest } = message as AnyRecord;
    return withContent(rest as SDKMessage, out);
  }

  /** Whatever still names a hidden skill (a reply, a door's printout)
   *  says "drawing standard" instead. */
  private renamed(message: SDKMessage): SDKMessage {
    if (!this.names || !this.named(JSON.stringify(message))) return message;
    return deep(message, (s) => s.replace(this.names!, NEUTRAL)) as SDKMessage;
  }

  private stream(message: Extract<SDKMessage, { type: 'stream_event' }>): SDKMessage | null {
    const ev = message.event as unknown;
    if (!isRecord(ev)) return message;
    const key = `${message.parent_tool_use_id ?? ''}:${String(ev.index)}`;
    if (ev.type === 'content_block_start') {
      const block = isRecord(ev.content_block) ? ev.content_block : null;
      if (block?.type === 'tool_use') this.streaming.set(key, block.name === 'Skill' ? null : '');
      return message;
    }
    if (ev.type === 'content_block_stop') {
      this.streaming.delete(key);
      return message;
    }
    const delta = isRecord(ev.delta) ? ev.delta : null;
    if (ev.type === 'content_block_delta' && delta?.type === 'text_delta' && this.named(String(delta.text ?? ''))) {
      return deep(message, (s) => s.replace(this.names!, NEUTRAL)) as SDKMessage;
    }
    if (ev.type !== 'content_block_delta' || delta?.type !== 'input_json_delta' || !this.streaming.has(key)) return message;
    const sofar = this.streaming.get(key);
    if (sofar === null) return null;
    const next = sofar + String(delta.partial_json ?? '');
    // stop before the name: the skills folder, or a hidden name begun
    if (/\.claude\\?\/skills/.test(next) || this.named(next)) {
      this.streaming.set(key, null);
      return null;
    }
    this.streaming.set(key, next);
    return message;
  }
}

function deep(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map((x) => deep(x, f));
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x, f)]));
  return v;
}

function withContent(message: SDKMessage, content: unknown): SDKMessage {
  const m = message as AnyRecord;
  return { ...m, message: { ...(m.message as AnyRecord), content } } as unknown as SDKMessage;
}

/** A conversation's history as a page may see it. */
export function redactHistory<T extends { type: string; message?: unknown }>(messages: T[], hidden?: ReadonlySet<string>): T[] {
  const r = new SkillRedactor(hidden);
  return messages.map((m) => (m.type === 'user' || m.type === 'assistant'
    ? (r.redact(m as unknown as SDKMessage) as unknown as T)
    : m));
}
