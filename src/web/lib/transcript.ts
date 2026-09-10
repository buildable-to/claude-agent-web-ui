// Turns the raw SDK message stream into something a chat view can render:
// user turns, assistant turns made of text and tool blocks, and notes.
// Pure functions; every update returns a new Transcript.
//
// Two rules keep a conversation looking the same live and after a reload
// (history has no stream events, no result messages and no clock):
// thinking blocks are dropped on both paths, and nothing here reads the time.

import type { HistoryMessage, SDKMessage } from '@shared/protocol';
import { parsePartialJson } from './parsePartialJson';

export type ToolImage = { mediaType: string; data: string };

/** What the engine says about a sub-agent it runs as a task: it started, it
 *  is getting on (progress), it settled. A backgrounded agent's tool result
 *  is a placeholder; this is where its real story lives. */
export type TaskState = {
  status: 'running' | 'completed' | 'failed' | 'stopped';
  /** A one-line progress summary while running; the finding once settled. */
  summary?: string;
  lastTool?: string;
  toolUses?: number;
  durationMs?: number;
  tokens?: number;
};

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
  /** Pictures the tool returned: a Read of a PNG, a screenshot. */
  images: ToolImage[];
  /** Tool calls made by a sub-agent this tool spawned. */
  children: ToolBlock[];
  /** The engine's own account of the sub-agent behind this call. */
  task?: TaskState;
};

/** A backgrounded sub-agent's tool result is this placeholder, not a finding. */
export const ASYNC_PLACEHOLDER = /^Async agent launched successfully/;

/** Still going: no result yet, or the engine says its task is still running. */
export function isInFlight(block: ToolBlock): boolean {
  if (block.task) return block.task.status === 'running';
  return block.result === undefined;
}
export type TextBlock = { type: 'text'; text: string };
export type Block = TextBlock | ToolBlock;

/** Claude Code's canned reply to a terminal command (/usage, /compact…); not the agent speaking. */
export const NO_RESPONSE = 'No response requested.';

export type Turn =
  | { kind: 'user'; id: string; text: string; images: number }
  | { kind: 'assistant'; id: string; blocks: Block[]; open: boolean }
  | { kind: 'note'; id: string; level: 'info' | 'error'; text: string };

type StreamState = {
  /** Rendered blocks in API order -> index into the open assistant turn's blocks. */
  positions: number[];
  /** API content-block index -> index into the open assistant turn's blocks. */
  byIndex: Record<number, number>;
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

/** What a tool result holds: its words and its pictures. */
function resultParts(content: unknown): { text: string; images: ToolImage[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) {
    return { text: content == null ? '' : JSON.stringify(content, null, 2), images: [] };
  }
  const texts: string[] = [];
  const images: ToolImage[] = [];
  for (const b of content) {
    if (!isRecord(b)) continue;
    if (b.type === 'text') texts.push(String(b.text ?? ''));
    else if (b.type === 'image') {
      const source = isRecord(b.source) ? b.source : null;
      if (source && source.type === 'base64' && typeof source.data === 'string') {
        images.push({ mediaType: String(source.media_type ?? 'image/png'), data: source.data });
      }
    }
  }
  return { text: texts.filter(Boolean).join('\n'), images };
}

/** The open assistant turn, if the newest turn (ignoring notes) is one. */
function lastAssistant(t: Transcript): number {
  // A note (a slash command's echo, a compaction) can land while the turn is
  // still open; it is not what closes the turn.
  let i = t.turns.length - 1;
  while (i >= 0 && t.turns[i]!.kind === 'note') i--;
  const turn = t.turns[i];
  return turn && turn.kind === 'assistant' && turn.open ? i : -1;
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

/** A content block worth rendering; thinking is not one. */
function toBlock(raw: AnyRecord): Block | null {
  switch (raw.type) {
    case 'text':
      return { type: 'text', text: String(raw.text ?? '') };
    case 'tool_use':
    case 'server_tool_use':
      return {
        type: 'tool_use',
        id: String(raw.id),
        name: String(raw.name),
        input: isRecord(raw.input) ? raw.input : {},
        done: true,
        images: [],
        children: [],
      };
    default:
      return null;
  }
}

function serverToolResult(raw: AnyRecord): { id: string; text: string } | null {
  if (typeof raw.type !== 'string' || !raw.type.endsWith('_tool_result')) return null;
  if (typeof raw.tool_use_id !== 'string') return null;
  return { id: raw.tool_use_id, text: resultParts(raw.content).text };
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
      if (msg.subtype === 'task_started' || msg.subtype === 'task_progress' || msg.subtype === 'task_notification') {
        return applyTask(t, msg as unknown as AnyRecord);
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
  return addUserTurn({ ...t, seen: new Set(t.seen).add(id) }, id, text, 0);
}

export function addNote(t: Transcript, id: string, level: 'info' | 'error', text: string): Transcript {
  if (t.seen.has(id)) return t;
  const seen = new Set(t.seen).add(id);
  return { ...t, seen, turns: [...t.turns, { kind: 'note', id, level, text }] };
}

/** Said when the engine died under an unfinished turn (a restart, a crash). */
export const CUT_TEXT =
  'The agent was stopped before it finished, by a restart. Say "continue" to pick up where it left off.';

/** A conversation whose newest turn (ignoring notes) ends in a tool call
 *  with no result never finished: the engine died under it. */
export function endedMidTurn(t: Transcript): boolean {
  let i = t.turns.length - 1;
  while (i >= 0 && t.turns[i]!.kind === 'note') i--;
  const turn = t.turns[i];
  if (!turn || turn.kind !== 'assistant') return false;
  const last = turn.blocks[turn.blocks.length - 1];
  return Boolean(last && last.type === 'tool_use' && last.result === undefined);
}

/** The engine is gone under this conversation: close what was open and say so once. */
export function markCut(t: Transcript, id: string): Transcript {
  if (lastAssistant(t) === -1 && !endedMidTurn(t)) return t;
  if (t.turns.some((x) => x.kind === 'note' && x.text === CUT_TEXT && x.id === id)) return t;
  return addNote(closeOpenTurn(t), id, 'info', CUT_TEXT);
}

/** The engine is still working on the newest turn (a second tab attached
 *  mid-turn, or the page came back): history closed it, so open it again for
 *  what the engine sends next. A turn ending in the engineer's own words is
 *  left alone: their words close a turn, the engine's next message opens one. */
export function reopenLastTurn(t: Transcript): Transcript {
  let i = t.turns.length - 1;
  while (i >= 0 && t.turns[i]!.kind === 'note') i--;
  const turn = t.turns[i];
  if (!turn || turn.kind !== 'assistant' || turn.open) return t;
  return { ...withTurn(t, i, { ...turn, open: true }), stream: null };
}

export function closeOpenTurn(t: Transcript): Transcript {
  const idx = lastAssistant(t);
  if (idx === -1) return { ...t, stream: null };
  const turn = t.turns[idx]!;
  if (turn.kind !== 'assistant') return { ...t, stream: null };
  const closed = withTurn(t, idx, { ...turn, open: false });
  return { ...closed, stream: null };
}

/** The engineer said something. The same words twice in a row (the page's
 *  own echo, then the engine's record of the command) show once. */
function addUserTurn(t: Transcript, id: string, text: string, images: number): Transcript {
  const last = t.turns[t.turns.length - 1];
  if (last && last.kind === 'user' && last.text === text && last.images === images) return t;
  const closed = closeOpenTurn(t);
  return { ...closed, turns: [...closed.turns, { kind: 'user', id, text, images }] };
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
      return {
        ...withTurn(next, idx, { ...turn, open: true }),
        stream: { positions: [], byIndex: {}, finalized: 0 },
      };
    }
    case 'content_block_start': {
      const raw = isRecord(ev.content_block) ? ev.content_block : null;
      const index = typeof ev.index === 'number' ? ev.index : -1;
      if (!raw || index < 0) return t;
      const [next, idx] = ensureOpenAssistant(t, `turn-${uuid}`);
      const stream = next.stream ?? { positions: [], byIndex: {}, finalized: 0 };
      let block = toBlock(raw);
      if (!block) return next;
      if (block.type === 'tool_use') block = { ...block, done: false, inputJson: '' };
      const turn = next.turns[idx]!;
      if (turn.kind !== 'assistant') return next;
      const blocks = [...turn.blocks, block];
      const at = blocks.length - 1;
      return {
        ...withTurn(next, idx, { ...turn, blocks }),
        stream: { ...stream, positions: [...stream.positions, at], byIndex: { ...stream.byIndex, [index]: at } },
      };
    }
    case 'content_block_delta': {
      const index = typeof ev.index === 'number' ? ev.index : -1;
      const pos = t.stream?.byIndex[index];
      const turnIdx = lastAssistant(t);
      const delta = isRecord(ev.delta) ? ev.delta : null;
      if (pos === undefined || turnIdx === -1 || !delta) return t;
      return updateBlock(t, turnIdx, pos, (b) => {
        if (delta.type === 'text_delta' && b.type === 'text') {
          return { ...b, text: b.text + String(delta.text ?? '') };
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
      const pos = t.stream?.byIndex[index];
      const turnIdx = lastAssistant(t);
      if (pos === undefined || turnIdx === -1) return t;
      return updateBlock(t, turnIdx, pos, (b) => {
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
    // Both paths skip the same blocks (thinking), so the order lines up.
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
                images: existing.images,
                children: existing.children,
              }
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
      const { text, images } = resultParts(r.content);
      next = updateTool(next, id, (b) => ({ ...b, result: text, isError: Boolean(r.is_error), images }));
    }
    return next;
  }

  if (parentToolUseId) return { ...t, seen };

  const rawText = raws
    .filter((r) => r.type === 'text')
    .map((r) => String(r.text ?? ''))
    .join('\n');
  const images = raws.filter((r) => r.type === 'image').length;

  // Claude Code records a slash command the engineer typed as a tagged user
  // message; show it as their own words. Its local output is a note.
  const command = /<command-name>([^<]*)<\/command-name>(?:.*?<command-args>([^<]*)<\/command-args>)?/s.exec(rawText);
  if (command) {
    const line = `${command[1]!.trim()} ${(command[2] ?? '').trim()}`.trim();
    return addUserTurn({ ...t, seen }, uuid, line.startsWith('/') ? line : `/${line}`, 0);
  }
  const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(rawText);
  if (stdout) {
    const out = stripAnsi(stdout[1]!).trim();
    return out ? addNote(t, uuid, 'info', out.length > 400 ? `${out.slice(0, 400)}…` : out) : { ...t, seen };
  }

  // A sub-agent settled: the engine tells the model in the user's voice.
  // It is the lane's finding, not the engineer speaking — and unlike the
  // live system message it is in the history, so a reload keeps it.
  const notified = /<task-notification>([\s\S]*?)<\/task-notification>/.exec(rawText);
  // Live, the notification wakes a new turn; closing the open one here keeps
  // history looking the same.
  if (notified) return closeOpenTurn(applyRecordedNotification({ ...t, seen }, notified[1]!));

  // Injected context (system reminders etc.) is not something the user typed.
  const text = rawText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text && !images) return { ...t, seen };

  // An interruption is worth a note. Anything else the engine adds in the
  // user's voice (a skill's text after "Launching skill", other context) is
  // not the engineer speaking and is not shown; history never has it either.
  if (/^\[Request interrupted/.test(text)) {
    return addNote(t, uuid, 'info', text.replace(/^\[|\]$/g, ''));
  }
  if (isSynthetic || /^Base directory for this skill:/.test(text)) return { ...t, seen };
  return addUserTurn({ ...t, seen }, uuid, text, images);
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

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);

/** How many steps that may have touched the folder have finished, sub-agents'
 *  included. The files panel reloads when this grows, so a file a sub-agent
 *  wrote shows while the turn is still running. */
export function finishedFileSteps(t: Transcript): number {
  let n = 0;
  for (const turn of t.turns) {
    if (turn.kind !== 'assistant') continue;
    for (const b of turn.blocks) {
      if (b.type !== 'tool_use') continue;
      if (FILE_TOOLS.has(b.name) && b.result !== undefined) n++;
      for (const c of b.children) if (FILE_TOOLS.has(c.name) && c.result !== undefined) n++;
    }
  }
  return n;
}

/** task_started / task_progress / task_notification, joined to the Task tool
 *  call by tool_use_id. Housekeeping tasks the engine hides are skipped. */
function applyTask(t: Transcript, msg: AnyRecord): Transcript {
  const uuid = typeof msg.uuid === 'string' ? msg.uuid : undefined;
  if (uuid && t.seen.has(uuid)) return t;
  const seen = uuid ? new Set(t.seen).add(uuid) : t.seen;
  const toolId = typeof msg.tool_use_id === 'string' ? msg.tool_use_id : '';
  if (!toolId || msg.ambient || msg.skip_transcript) return { ...t, seen };
  const usage = isRecord(msg.usage) ? msg.usage : null;
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return updateTool({ ...t, seen }, toolId, (b) => {
    const prev: TaskState = b.task ?? { status: 'running' };
    switch (msg.subtype) {
      case 'task_started':
        return { ...b, task: { ...prev, status: 'running' } };
      case 'task_progress':
        return {
          ...b,
          task: {
            ...prev,
            status: 'running',
            summary: str(msg.summary) ?? prev.summary,
            lastTool: str(msg.last_tool_name) ?? prev.lastTool,
            toolUses: num(usage?.tool_uses) ?? prev.toolUses,
            durationMs: num(usage?.duration_ms) ?? prev.durationMs,
            tokens: num(usage?.total_tokens) ?? prev.tokens,
          },
        };
      case 'task_notification': {
        const status = msg.status === 'failed' || msg.status === 'stopped' ? msg.status : 'completed';
        return {
          ...b,
          task: {
            ...prev,
            status,
            summary: str(msg.summary) ?? prev.summary,
            toolUses: num(usage?.tool_uses) ?? prev.toolUses,
            durationMs: num(usage?.duration_ms) ?? prev.durationMs,
            tokens: num(usage?.total_tokens) ?? prev.tokens,
          },
        };
      }
      default:
        return b;
    }
  });
}

/** Sub-agents the engine is still running in the background, across the
 *  whole conversation: the page is not idle while they are. */
export function runningAgents(t: Transcript): number {
  let n = 0;
  for (const turn of t.turns) {
    if (turn.kind !== 'assistant') continue;
    for (const b of turn.blocks) if (b.type === 'tool_use' && b.task?.status === 'running') n++;
  }
  return n;
}

/** The recorded form of a task_notification:
 *  <task-notification><tool-use-id>…</tool-use-id><status>completed</status>
 *  <result>…</result><usage><tool_uses>3</tool_uses><duration_ms>…</duration_ms></usage></task-notification> */
function applyRecordedNotification(t: Transcript, body: string): Transcript {
  const tag = (name: string) => {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
    return m ? m[1]!.trim() : undefined;
  };
  const toolId = tag('tool-use-id');
  if (!toolId) return t;
  const status = tag('status');
  const result = tag('result');
  const toolUses = Number(tag('tool_uses'));
  const durationMs = Number(tag('duration_ms'));
  const tokens = Number(tag('subagent_tokens'));
  return updateTool(t, toolId, (b) => {
    const prev: TaskState = b.task ?? { status: 'running' };
    // The live system message may already have said so; the record wins
    // only where it knows more (its result is the finding in full).
    return {
      ...b,
      task: {
        ...prev,
        status: status === 'failed' || status === 'stopped' ? status : 'completed',
        summary: result || prev.summary,
        toolUses: Number.isFinite(toolUses) ? toolUses : prev.toolUses,
        durationMs: Number.isFinite(durationMs) ? durationMs : prev.durationMs,
        tokens: Number.isFinite(tokens) ? tokens : prev.tokens,
      },
    };
  });
}
