// What the agent reads of its own skills stays on the server (Buildable #1253).
//
// Some of the agent's skills are its own method, not the engineer's: a skill
// whose header says `user-invocable: false` (Claude Code's field: only the
// model loads it) — Buildable's drawing standard. The page already hid a skill
// loading as a step, but the engine's messages still carried the skill's whole
// text (the "Base directory for this skill" message) and whatever the agent
// read of it. Every message a page is sent — live, replayed, or read back from
// history — passes here first:
// - a skill loading, and a step that reads a hidden skill or the skills
//   folder as a whole, becomes a bare `Skill` step (hidden by the page) with
//   no input and no result;
// - a helper's brief that names a hidden skill is not sent (the card stays);
// - the skill's text is dropped;
// - a hidden skill's name anywhere else the agent wrote reads "drawing
//   standard" (the engineer's own words stay as typed);
// - streamed, a helper's brief is not sent at all, and other text holds back
//   whatever could be the start of a hidden name until it is known.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeConfigDir } from './commands.js';

type AnyRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is AnyRecord => typeof v === 'object' && v !== null && !Array.isArray(v);

const SKILL_TEXT = /^\s*Base directory for this skill:/;
/** a path into the skills folder; its first part, the skill's folder */
const SKILLS_PATH = /\.claude\\?\/skills(?:\\?\/([^\s"'\\/]*))?/g;
const HELPERS = new Set(['Agent', 'Task']);
/** steps that read: a hidden name in their input is a read of that skill */
const READERS = new Set(['Bash', 'Read', 'Grep', 'Glob']);
const WATCH = ['.claude/skills', '.claude\\/skills'];
const NEUTRAL = 'drawing standard';

type Home = { hidden: ReadonlySet<string>; shown: ReadonlySet<string> };
let cache: { at: number; dir: string; home: Home } | null = null;

/** The hidden skills of the agent's Claude home, read again each minute. */
export function hiddenSkills(dir = claudeConfigDir()): ReadonlySet<string> {
  return home(dir).hidden;
}

function home(dir = claudeConfigDir()): Home {
  if (cache && cache.dir === dir && Date.now() - cache.at < 60_000) return cache.home;
  const names = new Set<string>();
  const shown = new Set<string>();
  try {
    for (const folder of readdirSync(join(dir, 'skills'))) {
      try {
        const head = /^---\s*\n([\s\S]*?)\n---/.exec(readFileSync(join(dir, 'skills', folder, 'SKILL.md'), 'utf8'))?.[1] ?? '';
        if (!/^user-invocable:\s*false\s*$/m.test(head)) {
          shown.add(folder);
          continue;
        }
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
  cache = { at: Date.now(), dir, home: { hidden: names, shown } };
  return cache.home;
}

/** One conversation's filter; it remembers which steps were a skill's, so
 *  their results are dropped too. Feed it messages in the engine's order. */
export class SkillRedactor {
  private readonly steps = new Set<string>();
  /** a streamed block, by `<helper>:<block index>`: what was sent and what
   *  is held back; `stopped`: nothing more of it is sent */
  private readonly streaming = new Map<string, { tool: boolean; sent: string; held: string; stopped: boolean }>();
  private readonly names: RegExp | null;
  private readonly watch: string[];
  private readonly shown: ReadonlySet<string>;

  constructor(hidden: ReadonlySet<string> = home().hidden, shown: ReadonlySet<string> = home().shown) {
    this.shown = shown;
    this.watch = [...WATCH, ...hidden];
    const words = [...hidden].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    this.names = words.length ? new RegExp(`(?<![A-Za-z0-9-])(?:${words.join('|')})(?![A-Za-z0-9-])`, 'g') : null;
  }

  /** The message as a page may see it; null: send nothing. */
  redact(message: SDKMessage): SDKMessage | null {
    if (message.type === 'assistant') return this.renamed(this.assistant(message));
    if (message.type === 'user') {
      const out = this.user(message);
      // the engineer's own words stay as typed (the page matches them so)
      const content: unknown = message.message.content;
      const theirs = !message.parent_tool_use_id
        && !(Array.isArray(content) && content.some((b) => isRecord(b) && b.type === 'tool_result'));
      return theirs ? out : this.renamed(out);
    }
    if (message.type === 'stream_event') return this.stream(message);
    if (message.type === 'system') {
      // a helper's lane: its brief, its description and summaries
      const out = 'prompt' in message && this.named(String(message.prompt ?? '')) ? { ...message, prompt: '' } as SDKMessage : message;
      return this.renamed(out);
    }
    return message;
  }

  private named(text: string): boolean {
    if (!this.names) return false;
    this.names.lastIndex = 0;
    return this.names.test(text);
  }

  /** a step that reads a hidden skill: the skills folder as a whole, a
   *  wildcard in it, a skill not known to be shown, or a reader naming one */
  private secret(name: string, input: unknown): boolean {
    const text = JSON.stringify(input ?? {}).replace(/\\\//g, '/');
    for (const m of text.matchAll(SKILLS_PATH)) {
      if (!this.shown.has(m[1] ?? '')) return true;
    }
    return READERS.has(name) && this.named(text);
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
      if (b.name !== 'Skill' && !this.secret(b.name, b.input)) return b;
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
      if (block?.type === 'tool_use' || block?.type === 'text') {
        // a skill loading or a helper's brief: never streamed, the final message says it
        const stopped = block.type === 'tool_use' && (block.name === 'Skill' || HELPERS.has(String(block.name)));
        this.streaming.set(key, { tool: block.type === 'tool_use', sent: '', held: '', stopped });
      }
      return message;
    }
    if (ev.type === 'content_block_stop') {
      this.streaming.delete(key);
      return message;
    }
    const delta = isRecord(ev.delta) ? ev.delta : null;
    const at = this.streaming.get(key);
    if (ev.type !== 'content_block_delta' || !delta || !at) return message;
    const field = at.tool ? 'partial_json' : 'text';
    if ((at.tool ? 'input_json_delta' : 'text_delta') !== delta.type) return message;
    if (at.stopped) return null;
    const pending = at.held + String(delta[field] ?? '');
    const all = at.sent + pending;
    // a tool's input stops before a skill's path or a hidden name; text says it plainly
    if (at.tool && (/\.claude\\?\/skills/.test(all) || this.named(all))) {
      at.stopped = true;
      return null;
    }
    const hold = this.tail(pending);
    let out = pending.slice(0, pending.length - hold);
    at.held = pending.slice(out.length);
    at.sent += out;
    if (!at.tool && this.names) out = out.replace(this.names, NEUTRAL);
    if (!out) return null;
    return { ...message, event: { ...ev, delta: { ...delta, [field]: out } } } as unknown as SDKMessage;
  }

  /** How much of the end of `text` could begin a watched word. */
  private tail(text: string): number {
    let best = 0;
    for (const w of this.watch) {
      for (let n = Math.min(w.length - 1, text.length); n > best; n--) {
        if (text.endsWith(w.slice(0, n))) {
          best = n;
          break;
        }
      }
    }
    return best;
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
export function redactHistory<T extends { type: string; message?: unknown }>(messages: T[], hidden?: ReadonlySet<string>, shown?: ReadonlySet<string>): T[] {
  const r = new SkillRedactor(hidden, shown);
  return messages.map((m) => (m.type === 'user' || m.type === 'assistant'
    ? (r.redact(m as unknown as SDKMessage) as unknown as T)
    : m));
}
