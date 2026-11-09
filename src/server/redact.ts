// What the agent reads of its skills stays on the server (Buildable #1253).
//
// A skill is the agent's method, not the engineer's conversation: Buildable's
// drawing standard is its own and must never reach a browser. The page
// already hides a skill loading as a step, but the engine's messages still
// carried the skill's whole text (the "Base directory for this skill" message)
// and whatever the agent read under a `.claude/skills/` folder. Every message
// a page is sent — live, replayed, or read back from history — passes here
// first: those steps become a bare `Skill` step with no input and no result,
// and the skill's text is dropped.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

type AnyRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is AnyRecord => typeof v === 'object' && v !== null && !Array.isArray(v);

const SKILL_PATH = '.claude/skills/';
const SKILL_TEXT = /^\s*Base directory for this skill:/;

/** One conversation's filter; it remembers which steps were a skill's, so
 *  their results are dropped too. Feed it messages in the engine's order. */
export class SkillRedactor {
  private readonly steps = new Set<string>();
  /** a streamed tool call's input so far, by `<helper>:<block index>`;
   *  null once it is a skill's: its input is no longer sent */
  private readonly streaming = new Map<string, string | null>();

  /** The message as a page may see it; null: send nothing. */
  redact(message: SDKMessage): SDKMessage | null {
    if (message.type === 'assistant') return this.assistant(message);
    if (message.type === 'user') return this.user(message);
    if (message.type === 'stream_event') return this.stream(message);
    return message;
  }

  private assistant(message: Extract<SDKMessage, { type: 'assistant' }>): SDKMessage {
    const content = message.message.content;
    if (!Array.isArray(content)) return message;
    let changed = false;
    const out = content.map((b) => {
      if (b.type !== 'tool_use' || !(b.name === 'Skill' || JSON.stringify(b.input ?? {}).includes(SKILL_PATH))) return b;
      this.steps.add(b.id);
      changed = true;
      return { ...b, name: 'Skill', input: {} };
    });
    return changed ? ({ ...message, message: { ...message.message, content: out } } as SDKMessage) : message;
  }

  private user(message: Extract<SDKMessage, { type: 'user' }>): SDKMessage {
    const content: unknown = message.message.content;
    if (typeof content === 'string') {
      return SKILL_TEXT.test(content) ? withContent(message, '') : message;
    }
    if (!Array.isArray(content)) return message;
    let changed = false;
    const out: unknown[] = [];
    for (const b of content) {
      if (isRecord(b) && b.type === 'text' && SKILL_TEXT.test(String(b.text ?? ''))) {
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
    if ('tool_use_result' in message && changed) {
      const { tool_use_result: _dropped, ...rest } = message as AnyRecord;
      return withContent(rest as SDKMessage, out);
    }
    return changed ? withContent(message, out) : message;
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
    if (ev.type !== 'content_block_delta' || delta?.type !== 'input_json_delta' || !this.streaming.has(key)) return message;
    const sofar = this.streaming.get(key);
    if (sofar === null) return null;
    const next = sofar + String(delta.partial_json ?? '');
    // a path is written with its slashes escaped in JSON
    if (next.replace(/\\\//g, '/').includes(SKILL_PATH)) {
      this.streaming.set(key, null);
      return null;
    }
    this.streaming.set(key, next);
    return message;
  }
}

function withContent(message: SDKMessage, content: unknown): SDKMessage {
  const m = message as AnyRecord;
  return { ...m, message: { ...(m.message as AnyRecord), content } } as unknown as SDKMessage;
}

/** A conversation's history as a page may see it. */
export function redactHistory<T extends { type: string; message?: unknown }>(messages: T[]): T[] {
  const r = new SkillRedactor();
  return messages.map((m) => (m.type === 'user' || m.type === 'assistant'
    ? (r.redact(m as unknown as SDKMessage) as unknown as T)
    : m));
}
