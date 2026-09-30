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
  /** When the turn began, on this page's clock. */
  since: number | null;
  transcript: Transcript;
};

export function WorkLine({ status, since, transcript }: Props) {
  const on = status === 'running' || status === 'starting';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  if (!on) return null;

  const step = status === 'running' ? currentStep(transcript) : null;
  const doing = status === 'starting' ? 'Starting' : 'Working';
  return (
    <div className="mx-auto w-full max-w-3xl px-5 max-sm:px-3" role="status" aria-live="polite">
      <div className="rise relative flex h-8 items-center gap-2 overflow-hidden rounded-full bg-accent-soft pr-3.5 pl-3 text-[12.5px]">
        <span className="size-2 shrink-0 rounded-full bg-accent breathe" aria-hidden />
        <span className="shrink-0 font-semibold text-ink">{doing}</span>
        {step && <span className="min-w-0 truncate text-ink-2">· {stepWords(step)}</span>}
        {since !== null && (
          <span className="ml-auto shrink-0 pl-2 font-mono text-[11.5px] text-ink-2 tabular-nums" title="Time on this turn">
            {clock(now - since)}
          </span>
        )}
        <span className="work-sweep" aria-hidden />
      </div>
    </div>
  );
}
