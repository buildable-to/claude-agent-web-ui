// Turns the raw SDK message stream into something a chat view can render:
// user turns, assistant turns made of text / thinking / tool blocks, and notes.
// Pure functions; every update returns a new Transcript.

import type { HistoryMessage, SDKMessage } from '@shared/protocol';
import { parsePartialJson } from './parsePartialJson';

export type ToolBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Raw JSON while the input is still streaming. */
  inputJson?: string;
  /** Input is complete. */
  done: boolean;
  result?: string;
  isError?: boolean;
  /** Wall-clock timings, only known for blocks seen live. */
  startedAt?: number;
  endedAt?: number;
  /** Tool calls made by a sub-agent this tool spawned. */
  children: ToolBlock[];
};
export type TextBlock = { type: 'text'; text: string };
export type ThinkingBlock = {
  type: 'thinking';
  thinking: string;
  done: boolean;
  startedAt?: number;
  durationMs?: number;
};
export type Block = TextBlock | ThinkingBlock | ToolBlock;

export type Turn =
  | { kind: 'user'; id: string; text: string; images: number }
  | { kind: 'assistant'; id: string; blocks: Block[]; open: boolean }
  | { kind: 'note'; id: string; level: 'info' | 'error'; text: string };

type StreamState = {
  /** API content-block index -> index into the open assistant turn's blocks. */
  positions: number[];
  /** How many streamed blocks have been replaced by their final version. */
  finalized: number;
};

export type Transcript = {
  turns: Turn[];
  seen: Set<string>;
  stream: StreamState | null;
};

export function emptyTranscript(): Transcript {
  return { turns: [], seen: new Set(), stream: null };
}

// --- helpers ---------------------------------------------------------------

type AnyRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is AnyRecord => typeof v === 'object' && v !== null;

function contentBlocks(message: unknown): AnyRecord[] {
  if (!isRecord(message)) return [];
  const c = message.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c.filter(isRecord) : [];
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content, null, 2);
  return content
    .map((b) => {
      if (!isRecord(b)) return '';
      if (b.type === 'text') return String(b.text ?? '');
      if (b.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function lastAssistant(t: Transcript): number {
  const last = t.turns[t.turns.length - 1];
  return last && last.kind === 'assistant' && last.open ? t.turns.length - 1 : -1;
}

function withTurn(t: Transcript, index: number, turn: Turn): Transcript {
  const turns = t.turns.slice();
  turns[index] = turn;
  return { ...t, turns };
}

function ensureOpenAssistant(t: Transcript, id: string): [Transcript, number] {
  const idx = lastAssistant(t);
  if (idx !== -1) return [t, idx];
  const turn: Turn = { kind: 'assistant', id, blocks: [], open: true };
  return [{ ...t, turns: [...t.turns, turn] }, t.turns.length];
}

function updateBlock(t: Transcript, turnIdx: number, blockIdx: number, fn: (b: Block) => Block): Transcript {
  const turn = t.turns[turnIdx];
  if (!turn || turn.kind !== 'assistant') return t;
  const block = turn.blocks[blockIdx];
  if (!block) return t;
  const blocks = turn.blocks.slice();
  blocks[blockIdx] = fn(block);
  return withTurn(t, turnIdx, { ...turn, blocks });
}

/** Find a tool block anywhere (including sub-agent children) by tool_use id. */
function findTool(t: Transcript, toolId: string): { turnIdx: number; path: number[] } | null {
  for (let i = t.turns.length - 1; i >= 0; i--) {
    const turn = t.turns[i]!;
    if (turn.kind !== 'assistant') continue;
    for (let b = turn.blocks.length - 1; b >= 0; b--) {
      const block = turn.blocks[b]!;
      if (block.type !== 'tool_use') continue;
      if (block.id === toolId) return { turnIdx: i, path: [b] };
      const c = block.children.findIndex((ch) => ch.id === toolId);
      if (c !== -1) return { turnIdx: i, path: [b, c] };
    }
  }
  return null;
}

function updateTool(t: Transcript, toolId: string, fn: (b: ToolBlock) => ToolBlock): Transcript {
  const loc = findTool(t, toolId);
  if (!loc) return t;
  const [b, c] = loc.path;
  return updateBlock(t, loc.turnIdx, b!, (block) => {
    if (block.type !== 'tool_use') return block;
    if (c === undefined) return fn(block);
    const children = block.children.slice();
    children[c] = fn(children[c]!);
    return { ...block, children };
  });
}

function toBlock(raw: AnyRecord): Block | null {
  switch (raw.type) {
    case 'text':
      return { type: 'text', text: String(raw.text ?? '') };
    case 'thinking':
      return { type: 'thinking', thinking: String(raw.thinking ?? ''), done: true };
    case 'redacted_thinking':
      return { type: 'thinking', thinking: '', done: true };
    case 'tool_use':
    case 'server_tool_use':
      return {
        type: 'tool_use',
        id: String(raw.id),
        name: String(raw.name),
        input: isRecord(raw.input) ? raw.input : {},
        done: true,
        children: [],
      };
    default:
      return null;
  }
}

function serverToolResult(raw: AnyRecord): { id: string; text: string } | null {
  if (typeof raw.type !== 'string' || !raw.type.endsWith('_tool_result')) return null;
  if (typeof raw.tool_use_id !== 'string') return null;
  return { id: raw.tool_use_id, text: resultText(raw.content) };
}

// --- reducer ---------------------------------------------------------------

export function applyMessage(t: Transcript, msg: SDKMessage): Transcript {
  switch (msg.type) {
    case 'stream_event':
      return msg.parent_tool_use_id ? t : applyStreamEvent(t, msg.event as unknown as AnyRecord, msg.uuid);
    case 'assistant':
      return applyAssistant(t, msg.uuid, msg.message as unknown, msg.parent_tool_use_id);
    case 'user':
      return applyUser(t, msg.uuid ?? cryptoId(), msg.message as unknown, msg.parent_tool_use_id, msg.isSynthetic);
    case 'result':
      return applyResult(t, msg);
    case 'system':
      if (msg.subtype === 'compact_boundary') {
        return addNote(t, msg.uuid, 'info', 'Earlier context was compacted to make room.');
      }
      return t;
    default:
      return t;
  }
}

export function applyHistory(t: Transcript, history: HistoryMessage[]): Transcript {
  let next = t;
  for (const h of history) {
    if (h.type === 'assistant') next = applyAssistant(next, h.uuid, h.message, h.parent_tool_use_id);
    else if (h.type === 'user') next = applyUser(next, h.uuid, h.message, h.parent_tool_use_id, false);
  }
  return closeOpenTurn(next);
}

export function addLocalUserTurn(t: Transcript, id: string, text: string): Transcript {
  if (t.seen.has(id)) return t;
  const seen = new Set(t.seen).add(id);
  const closed = closeOpenTurn(t);
  return { ...closed, seen, turns: [...closed.turns, { kind: 'user', id, text, images: 0 }] };
}

export function addNote(t: Transcript, id: string, level: 'info' | 'error', text: string): Transcript {
  if (t.seen.has(id)) return t;
  const seen = new Set(t.seen).add(id);
  return { ...t, seen, turns: [...t.turns, { kind: 'note', id, level, text }] };
}

export function closeOpenTurn(t: Transcript): Transcript {
  const idx = lastAssistant(t);
  if (idx === -1) return { ...t, stream: null };
  const turn = t.turns[idx]!;
  if (turn.kind !== 'assistant') return { ...t, stream: null };
  const closed = withTurn(t, idx, { ...turn, open: false });
  return { ...closed, stream: null };
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

function cryptoId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function applyStreamEvent(t: Transcript, ev: AnyRecord, uuid: string): Transcript {
  switch (ev.type) {
    case 'message_start': {
      const [next, idx] = ensureOpenAssistant(t, `turn-${uuid}`);
      const turn = next.turns[idx]!;
      if (turn.kind !== 'assistant') return next;
      return { ...withTurn(next, idx, { ...turn, open: true }), stream: { positions: [], finalized: 0 } };
    }
    case 'content_block_start': {
      const raw = isRecord(ev.content_block) ? ev.content_block : null;
      const index = typeof ev.index === 'number' ? ev.index : -1;
      if (!raw || index < 0) return t;
      const [next, idx] = ensureOpenAssistant(t, `turn-${uuid}`);
      const stream = next.stream ?? { positions: [], finalized: 0 };
      let block = toBlock(raw);
      if (!block) return next;
      if (block.type === 'thinking') block = { ...block, done: false, startedAt: Date.now() };
      if (block.type === 'tool_use') block = { ...block, done: false, inputJson: '', startedAt: Date.now() };
      const turn = next.turns[idx]!;
      if (turn.kind !== 'assistant') return next;
      const blocks = [...turn.blocks, block];
      const positions = stream.positions.slice();
      positions[index] = blocks.length - 1;
      return { ...withTurn(next, idx, { ...turn, blocks }), stream: { ...stream, positions } };
    }
    case 'content_block_delta': {
      const index = typeof ev.index === 'number' ? ev.index : -1;
      const pos = t.stream?.positions[index];
      const turnIdx = lastAssistant(t);
      const delta = isRecord(ev.delta) ? ev.delta : null;
      if (pos === undefined || turnIdx === -1 || !delta) return t;
      return updateBlock(t, turnIdx, pos, (b) => {
        if (delta.type === 'text_delta' && b.type === 'text') {
          return { ...b, text: b.text + String(delta.text ?? '') };
        }
        if (delta.type === 'thinking_delta' && b.type === 'thinking') {
          return { ...b, thinking: b.thinking + String(delta.thinking ?? '') };
        }
        if (delta.type === 'input_json_delta' && b.type === 'tool_use') {
          const inputJson = (b.inputJson ?? '') + String(delta.partial_json ?? '');
          const parsed = parsePartialJson<Record<string, unknown>>(inputJson);
          return { ...b, inputJson, input: parsed && isRecord(parsed) ? parsed : b.input };
        }
        return b;
      });
    }
    case 'content_block_stop': {
      const index = typeof ev.index === 'number' ? ev.index : -1;
      const pos = t.stream?.positions[index];
      const turnIdx = lastAssistant(t);
      if (pos === undefined || turnIdx === -1) return t;
      return updateBlock(t, turnIdx, pos, (b) => {
        if (b.type === 'thinking') {
          return { ...b, done: true, durationMs: b.startedAt ? Date.now() - b.startedAt : undefined };
        }
        if (b.type === 'tool_use') {
          const parsed = b.inputJson ? parsePartialJson<Record<string, unknown>>(b.inputJson) : null;
          return { ...b, done: true, input: parsed && isRecord(parsed) ? parsed : b.input };
        }
        return b;
      });
    }
    default:
      return t;
  }
}

function applyAssistant(t: Transcript, uuid: string, message: unknown, parentToolUseId: string | null): Transcript {
  if (t.seen.has(uuid)) return t;
  const seen = new Set(t.seen).add(uuid);
  const raws = contentBlocks(message);

  // Sub-agent activity: hang tool calls under the parent Task tool.
  if (parentToolUseId) {
    let next: Transcript = { ...t, seen };
    for (const raw of raws) {
      const block = toBlock(raw);
      if (!block || block.type !== 'tool_use') continue;
      next = updateTool(next, parentToolUseId, (parent) => ({
        ...parent,
        children: parent.children.some((c) => c.id === block.id)
          ? parent.children
          : [...parent.children, block],
      }));
    }
    return next;
  }

  let [next, idx] = ensureOpenAssistant({ ...t, seen }, `turn-${uuid}`);
  for (const raw of raws) {
    const serverResult = serverToolResult(raw);
    if (serverResult) {
      next = updateTool(next, serverResult.id, (b) => ({ ...b, result: serverResult.text }));
      continue;
    }
    const block = toBlock(raw);
    if (!block) continue;
    const turn = next.turns[idx]!;
    if (turn.kind !== 'assistant') continue;
    const stream = next.stream;
    // Replace the streamed version of this block with the final one, in order.
    if (stream && stream.finalized < stream.positions.length) {
      const pos = stream.positions[stream.finalized];
      const existing = pos !== undefined ? turn.blocks[pos] : undefined;
      if (pos !== undefined && existing && existing.type === block.type) {
        const merged: Block =
          existing.type === 'tool_use' && block.type === 'tool_use'
            ? {
                ...block,
                result: existing.result,
                isError: existing.isError,
                startedAt: existing.startedAt,
                endedAt: existing.endedAt,
                children: existing.children,
              }
            : existing.type === 'thinking' && block.type === 'thinking'
              ? { ...block, startedAt: existing.startedAt, durationMs: existing.durationMs }
              : block;
        next = updateBlock(next, idx, pos, () => merged);
        next = { ...next, stream: { ...stream, finalized: stream.finalized + 1 } };
        continue;
      }
    }
    // Tool blocks can be re-sent; never duplicate by id.
    if (block.type === 'tool_use' && turn.blocks.some((b) => b.type === 'tool_use' && b.id === block.id)) {
      continue;
    }
    next = withTurn(next, idx, { ...turn, blocks: [...turn.blocks, block] });
  }
  return next;
}

function applyUser(
  t: Transcript,
  uuid: string,
  message: unknown,
  parentToolUseId: string | null,
  isSynthetic: boolean | undefined,
): Transcript {
  if (t.seen.has(uuid)) return t;
  const seen = new Set(t.seen).add(uuid);
  const raws = contentBlocks(message);
  const results = raws.filter((r) => r.type === 'tool_result');

  if (results.length) {
    let next: Transcript = { ...t, seen };
    for (const r of results) {
      const id = String(r.tool_use_id ?? '');
      if (!id) continue;
      next = updateTool(next, id, (b) => ({
        ...b,
        result: resultText(r.content),
        isError: Boolean(r.is_error),
        ...(b.startedAt && !b.endedAt ? { endedAt: Date.now() } : {}),
      }));
    }
    return next;
  }

  if (parentToolUseId) return { ...t, seen };

  const rawText = raws
    .filter((r) => r.type === 'text')
    .map((r) => String(r.text ?? ''))
    .join('\n');
  const images = raws.filter((r) => r.type === 'image').length;

  // Claude Code records slash commands and their output as user messages.
  const command = /<command-name>([^<]*)<\/command-name>(?:.*?<command-args>([^<]*)<\/command-args>)?/s.exec(rawText);
  if (command) {
    const line = `${command[1]!.trim()} ${(command[2] ?? '').trim()}`.trim();
    return addNote(t, uuid, 'info', line.startsWith('/') ? line : `/${line}`);
  }
  const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(rawText);
  if (stdout) {
    const out = stripAnsi(stdout[1]!).trim();
    return out ? addNote(t, uuid, 'info', out.length > 400 ? `${out.slice(0, 400)}…` : out) : { ...t, seen };
  }

  // Injected context (system reminders etc.) is not something the user typed.
  const text = rawText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text && !images) return { ...t, seen };

  if (isSynthetic || /^\[Request interrupted/.test(text)) {
    return addNote(t, uuid, 'info', text.replace(/^\[|\]$/g, ''));
  }
  const closed = closeOpenTurn({ ...t, seen });
  return { ...closed, turns: [...closed.turns, { kind: 'user', id: uuid, text, images }] };
}

function applyResult(t: Transcript, msg: Extract<SDKMessage, { type: 'result' }>): Transcript {
  if (t.seen.has(msg.uuid)) return t;
  const seen = new Set(t.seen).add(msg.uuid);
  let next = closeOpenTurn({ ...t, seen });
  if (msg.subtype !== 'success' || msg.is_error) {
    const detail =
      'errors' in msg && Array.isArray(msg.errors) && msg.errors.length
        ? msg.errors.join('\n')
        : msg.subtype === 'success'
          ? msg.result
          : msg.subtype.replace(/^error_/, '').replace(/_/g, ' ');
    next = addNote(next, `${msg.uuid}-err`, 'error', detail || 'The turn ended with an error.');
  }
  return next;
}
