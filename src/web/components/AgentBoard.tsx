// Sub-agents that ran side by side, readable without opening anything: a
// headline count, one line per agent with what it is doing or what it found,
// folding to one row when the last one returns. Time is the browser's clock;
// after a reload the rows show steps, not seconds.
import { Check, ChevronDown, ChevronRight, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  agentName,
  fmtElapsed,
  isSubAgent,
  laneElapsed,
  laneState,
  laneSteps,
  noteLaneTime,
} from '@/lib/agents';
import type { ToolBlock } from '@/lib/transcript';
import { Steps } from './Steps';
import { TaskBody } from './tools/cards';
import { toolDetail } from './tools/config';

/** Lanes shown in full while agents run; the rest of the finished ones fold. */
const LANES_IN_FULL = 8;

type Props = {
  blocks: ToolBlock[];
  /** The turn is still running. */
  live: boolean;
};

/** A stretch of work with a fan-out in it: the other steps as today's pill,
 *  then the board. */
export function FanOut({ blocks, live }: Props) {
  const agents = blocks.filter(isSubAgent);
  const rest = blocks.filter((b) => !isSubAgent(b));
  return (
    <div className="space-y-2">
      {rest.length > 0 && <Steps blocks={rest} live={live} />}
      <AgentBoard agents={agents} live={live} />
    </div>
  );
}

function useClock(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return on ? now : Date.now();
}

function boardElapsed(agents: ToolBlock[], now: number): number | undefined {
  let start = Infinity;
  let end = -Infinity;
  for (const a of agents) {
    const t = noteLaneTime(a, now);
    if (!t) return undefined;
    start = Math.min(start, t.start);
    end = Math.max(end, t.end ?? now);
  }
  return agents.length ? end - start : undefined;
}

export function AgentBoard({ agents, live }: { agents: ToolBlock[]; live: boolean }) {
  const running = agents.filter((a) => laneState(a, live) === 'running');
  const failed = agents.filter((a) => laneState(a, live) === 'failed').length;
  const done = agents.length - running.length;
  const busy = running.length > 0;
  const now = useClock(busy);
  const elapsed = boardElapsed(agents, now);

  // Open while agents run, folded once they are all back — unless the
  // engineer said otherwise.
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? busy;
  const [all, setAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleLane = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const word = agents.length === 1 ? 'agent' : 'agents';
  const headline = busy
    ? `${agents.length} ${word} · ${done} done${failed ? ` · ${failed} failed` : ''}`
    : `${agents.length} ${word}${failed ? ` · ${failed} failed` : ''}`;

  // Running lanes first while it is busy; finished lanes beyond the screen fold.
  let lanes = agents;
  let folded = 0;
  if (busy && agents.length > LANES_IN_FULL && !all) {
    const finished = agents.filter((a) => laneState(a, live) !== 'running');
    const room = Math.max(0, LANES_IN_FULL - running.length);
    lanes = [...running, ...finished.slice(0, room)];
    folded = finished.length - Math.min(room, finished.length);
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setChoice(!open)}
        aria-expanded={open}
        className="inline-flex h-6.5 max-w-full items-center gap-1.5 rounded-full bg-panel-2/80 pr-2 pl-2 text-left text-[11.5px] font-medium text-ink-2 hover:bg-panel-3 hover:text-ink"
      >
        {busy ? (
          <span className="size-2 shrink-0 rounded-full bg-accent breathe" aria-hidden />
        ) : failed ? (
          <X className="size-3.5 shrink-0 text-warn" aria-hidden />
        ) : (
          <Check className="size-3.5 shrink-0 text-sea" aria-hidden />
        )}
        <span className={`truncate ${busy ? 'breathe' : ''}`}>{headline}</span>
        {elapsed !== undefined && <span className="shrink-0 font-normal text-ink-3">{fmtElapsed(elapsed)}</span>}
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        )}
      </button>
      {open && (
        <div className="rise ml-1 space-y-0.5 border-l border-line-2 pl-3">
          {lanes.map((a) => (
            <Lane
              key={a.id}
              agent={a}
              live={live}
              now={now}
              open={expanded.has(a.id)}
              onToggle={() => toggleLane(a.id)}
            />
          ))}
          {folded > 0 && (
            <button
              type="button"
              onClick={() => setAll(true)}
              className="flex h-6 items-center gap-2 rounded px-1.5 text-[12px] text-ink-3 hover:bg-panel-2/70 hover:text-ink"
            >
              <Check className="size-3.5 shrink-0 text-sea" aria-hidden />
              {folded} more done
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type LaneProps = {
  agent: ToolBlock;
  live: boolean;
  now: number;
  open: boolean;
  onToggle: () => void;
};

function Lane({ agent, live, now, open, onToggle }: LaneProps) {
  const state = laneState(agent, live);
  const back = state !== 'running';
  const detail = toolDetail(agent) ?? (state === 'running' ? 'Working' : undefined);
  const steps = laneSteps(agent);
  const elapsed = laneElapsed(agent, now);
  const tail = back
    ? [steps ? `${steps} step${steps === 1 ? '' : 's'}` : null, elapsed !== undefined ? fmtElapsed(elapsed) : null]
        .filter(Boolean)
        .join(' · ')
    : elapsed !== undefined && state === 'running'
      ? fmtElapsed(elapsed)
      : '';

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={detail}
        className="flex h-6 w-full items-center gap-2 rounded px-1.5 text-left text-[12.5px] hover:bg-panel-2/70"
      >
        {state === 'running' ? (
          <span className="size-2 shrink-0 rounded-full bg-accent breathe" aria-hidden />
        ) : state === 'failed' ? (
          <X className="size-3.5 shrink-0 text-warn" aria-hidden />
        ) : back ? (
          <Check className="size-3.5 shrink-0 text-sea" aria-hidden />
        ) : (
          <span className="size-2 shrink-0 rounded-full border border-ink-3" aria-hidden />
        )}
        <span className="shrink-0 font-medium text-ink">{agentName(agent)}</span>
        {detail && (
          <span className={`min-w-0 flex-1 truncate text-[12px] ${state === 'failed' ? 'text-warn' : 'text-ink-2'}`}>
            {detail}
          </span>
        )}
        {!detail && <span className="flex-1" />}
        {tail && <span className="shrink-0 text-[11px] text-ink-3">{tail}</span>}
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        )}
      </button>
      {open && (
        <div className="rise mb-1.5 ml-5 space-y-2 rounded-lg border border-line bg-panel/80 px-3 py-2.5">
          <TaskBody tool={agent} live={live && !back} />
        </div>
      )}
    </div>
  );
}
