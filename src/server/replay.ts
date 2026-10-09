// What a page that opens a running conversation is sent to catch up.
//
// The buffer holds everything the engine said since it started. A long
// conversation with helpers grows it past what a page can take in one
// message (Buildable, 2026-10-09: 17 helpers over 2½ hours, ~90 MB; the
// attach never arrived, so the composer stayed locked on "connecting").
// Two things are never sent again: what the page cannot use, and what its
// history already holds.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

type AnyRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is AnyRecord => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A buffered message as the page needs it, kept in place of the original.
 *  - `tool_use_result` (the tool's structured output) — the page reads the
 *    tool_result blocks, never this.
 *  - A helper's pictures: the page counts them ("2 pictures") but only ever
 *    draws the main conversation's. The block stays, its bytes go.
 *  - A helper's thinking: the page draws no thinking. */
export function forReplay(message: SDKMessage): SDKMessage {
  if (message.type !== 'user' && message.type !== 'assistant') return message;
  let out = message as AnyRecord;
  if ('tool_use_result' in out) {
    const { tool_use_result: _dropped, ...rest } = out;
    out = rest;
  }
  if (!message.parent_tool_use_id) return out as SDKMessage;
  const inner = out.message;
  if (!isRecord(inner) || !Array.isArray(inner.content)) return out as SDKMessage;
  const content = message.type === 'assistant'
    ? inner.content.filter((b) => !(isRecord(b) && (b.type === 'thinking' || b.type === 'redacted_thinking')))
    : inner.content.map((b) => (isRecord(b) && b.type === 'tool_result' && Array.isArray(b.content)
      ? { ...b, content: b.content.map(withoutBytes) }
      : b));
  return { ...out, message: { ...inner, content } } as SDKMessage;
}

function withoutBytes(block: unknown): unknown {
  if (!isRecord(block) || block.type !== 'image' || !isRecord(block.source) || block.source.type !== 'base64') return block;
  return { ...block, source: { ...block.source, data: '' } };
}

/** A message of the main conversation that history (the session file) holds. */
function inHistory(message: SDKMessage): boolean {
  return (message.type === 'user' || message.type === 'assistant') && !message.parent_tool_use_id;
}

/** The buffer minus the main conversation's messages up to the newest one
 *  the page already has (`known`: the uuids it read last, from history or
 *  live). Everything else stays: helpers' steps and the engine's task and
 *  status notes are in no history. When none of `known` is in the buffer
 *  (the page knows nothing yet, or the engine started after it), all of it. */
export function replaySince(buffer: readonly SDKMessage[], known: readonly string[] | undefined): SDKMessage[] {
  if (!known?.length) return [...buffer];
  const have = new Set(known);
  let upTo = -1;
  for (let i = buffer.length - 1; i >= 0; i--) {
    const m = buffer[i]!;
    if (inHistory(m) && have.has(m.uuid ?? '')) {
      upTo = i;
      break;
    }
  }
  return buffer.filter((m, i) => i > upTo || !inHistory(m));
}
