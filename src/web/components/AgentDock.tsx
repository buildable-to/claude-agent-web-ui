// The sub-agents still running, kept under the chat where nothing can scroll
// them away: one row each, the ones already back marked done, the whole thing
// gone the moment the last one returns — the board in the transcript is the
// record. The page's version of what Claude Code's terminal shows under its
// prompt; done rows stay in view here because the engineer reads findings in
// the chat, not in a task list.
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { fmtElapsed, laneState, type DockLane } from '@/lib/agents';
import { boardElapsed, Lane, useClock } from './AgentBoard';

/** Rows in view before the dock scrolls inside itself, so a ten-agent fan-out
 *  never eats the chat — least of all in the Project Studio panel. */
const ROWS_IN_VIEW = 5;
const ROW_PX = 24;
/** Room for one opened card. */
const OPEN_PX = 320;

export function AgentDock({ lanes }: { lanes: DockLane[] }) {
  const running = lanes.filter((l) => laneState(l.agent, l.live) === 'running').length;
  const failed = lanes.filter((l) => laneState(l.agent, l.live) === 'failed').length;
  const done = lanes.length - running;
  const now = useClock(true);
  const elapsed = boardElapsed(
    lanes.map((l) => l.agent),
    now,
  );
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleLane = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const anyOpen = lanes.some((l) => expanded.has(l.agent.id));

  const word = lanes.length === 1 ? 'agent' : 'agents';
  const headline = `${lanes.length} ${word} · ${running} running${done ? ` · ${done - failed} done` : ''}${
    failed ? ` · ${failed} failed` : ''
  }`;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-2" role="region" aria-label="Agents running">
      <div className="rise rounded-xl border border-line bg-panel/90 px-2 py-1.5 shadow-strong backdrop-blur">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex h-6.5 w-full items-center gap-2 rounded-lg px-1.5 text-left text-[11.5px] font-medium text-ink-2 hover:bg-panel-2/70 hover:text-ink"
        >
          <span className="size-2 shrink-0 rounded-full bg-accent breathe" aria-hidden />
          <span className="min-w-0 flex-1 truncate breathe">{headline}</span>
          {elapsed !== undefined && <span className="shrink-0 font-normal text-ink-3">{fmtElapsed(elapsed)}</span>}
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-ink-3" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-ink-3" aria-hidden />
          )}
        </button>
        {open && (
          <div
            className="mt-1 space-y-0.5 overflow-y-auto"
            style={{ maxHeight: anyOpen ? OPEN_PX : ROWS_IN_VIEW * ROW_PX + 4 }}
          >
            {lanes.map((l) => (
              <Lane
                key={l.agent.id}
                agent={l.agent}
                live={l.live}
                now={now}
                open={expanded.has(l.agent.id)}
                onToggle={() => toggleLane(l.agent.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
