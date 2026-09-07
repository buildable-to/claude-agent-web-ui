// Sub-agents as the page reads them: a Task/Agent tool block whose children
// are the calls the sub-agent made and whose result is its finding. Pure
// helpers; the board and the card both lean on them.
import type { ToolBlock } from './transcript';

export const DEFAULT_AGENT_TYPE = 'general-purpose';

export function isSubAgent(block: ToolBlock): boolean {
  return block.name === 'Task' || block.name === 'Agent';
}

/** Two or more sub-agents in one stretch of work: they ran side by side. */
export function isFanOut(blocks: ToolBlock[]): boolean {
  return blocks.filter(isSubAgent).length >= 2;
}

/** "Research F3 fachwerk footing" — the agent's own words for the job. */
export function agentName(block: ToolBlock): string {
  const d = block.input.description;
  return typeof d === 'string' && d.trim() ? d.trim() : 'Sub-agent';
}

/** The agent type when it is worth a word; the default one is not. */
export function agentType(block: ToolBlock): string | undefined {
  const t = block.input.subagent_type;
  return typeof t === 'string' && t && t !== DEFAULT_AGENT_TYPE ? t : undefined;
}

export type LaneState = 'running' | 'done' | 'failed';

export function laneState(block: ToolBlock, live: boolean): LaneState {
  if (block.result === undefined) return live ? 'running' : 'done';
  return block.isError ? 'failed' : 'done';
}

/** The first line of a finding, plain enough for one row. */
export function findingLine(result: string | undefined, max = 110): string | undefined {
  if (!result) return undefined;
  const line = result
    .split('\n')
    .map((l) => l.replace(/^[\s#>*\-•]+/, '').replace(/\*\*/g, '').trim())
    .find((l) => l.length > 0);
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** "3m 12s", "41s" */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/** When each sub-agent was first seen and when its finding came back, on the
 *  browser's clock. The transcript carries no time on purpose, so this lives
 *  beside it for as long as the page does. */
const clock = new Map<string, { start: number; end?: number }>();

export function noteLaneTime(block: ToolBlock, now = Date.now()): { start: number; end?: number } {
  let t = clock.get(block.id);
  if (!t) {
    t = { start: now };
    clock.set(block.id, t);
  }
  if (block.result !== undefined && t.end === undefined) t.end = now;
  return t;
}

/** Elapsed for a lane the page watched from the start; undefined after a reload. */
export function laneElapsed(block: ToolBlock, now = Date.now()): number | undefined {
  const t = clock.get(block.id);
  if (!t) return undefined;
  return (t.end ?? now) - t.start;
}

export function resetLaneClock() {
  clock.clear();
}
