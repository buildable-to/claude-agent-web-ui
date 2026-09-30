// The one place that says the agent is at work, pinned above the composer so
// it never scrolls away: what it is doing now and how long the turn has run.
// The clock ticks every second, so a long step (a render, a queue for the
// server) still reads as alive; a step that changes says it is getting on.
import { useEffect, useState } from 'react';
import type { SessionStatus } from '@shared/protocol';
import { clock } from '@/lib/format';
import { currentStep, type Transcript } from '@/lib/transcript';
import { stepWords } from './tools/config';

type Props = {
  status: SessionStatus | 'connecting';
  /** The turn ended, but sub-agents or backgrounded commands still run: the
   *  engine's words for them (may be empty when only the transcript knows). */
  background: string[] | null;
  /** When the turn began, on this page's clock. */
  since: number | null;
  transcript: Transcript;
};

export function WorkLine({ status, background, since, transcript }: Props) {
  const on = status === 'running' || status === 'starting' || background !== null;
  const [now, setNow] = useState(() => Date.now());
  // background work has no turn clock: count from when this page saw it
  const [seen, setSeen] = useState<number | null>(null);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    setSeen(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  if (!on) return null;

  const step = status === 'starting' ? null : currentStep(transcript);
  const doing = status === 'starting' ? 'Starting' : background ? 'Working in the background' : 'Working';
  const what = background?.length
    ? background[0] + (background.length > 1 ? ` +${background.length - 1}` : '')
    : step && stepWords(step);
  const start = since ?? seen;
  return (
    <div className="mx-auto w-full max-w-3xl px-5 max-sm:px-3" role="status" aria-live="polite">
      <div className="rise relative flex h-8 items-center gap-2 overflow-hidden rounded-full bg-accent-soft pr-3.5 pl-3 text-[12.5px]">
        <span className="size-2 shrink-0 rounded-full bg-accent breathe" aria-hidden />
        <span className="shrink-0 font-semibold text-ink">{doing}</span>
        {what && <span className="min-w-0 truncate text-ink-2">· {what}</span>}
        {start !== null && (
          <span className="ml-auto shrink-0 pl-2 font-mono text-[11.5px] text-ink-2 tabular-nums" title="Time at work">
            {clock(now - start)}
          </span>
        )}
        <span className="work-sweep" aria-hidden />
      </div>
    </div>
  );
}
