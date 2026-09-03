import { useEffect, useRef } from 'react';
import type { SessionStatus } from '@shared/protocol';
import type { Turn } from '@/lib/transcript';
import { TurnView } from './TurnView';

type Props = {
  turns: Turn[];
  status: SessionStatus | 'connecting';
  loading: boolean;
  projectName: string;
};

const SNAP_PX = 48;

export function MessageList({ turns, status, loading, projectName }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= SNAP_PX;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns, status]);

  const last = turns[turns.length - 1];
  const waiting =
    status === 'running' && (!last || last.kind !== 'assistant' || last.blocks.length === 0);

  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 px-5 py-6">
        {loading && <p className="text-center text-[13px] text-ink-3">Loading conversation…</p>}
        {!loading && turns.length === 0 && (
          <div className="pt-24 text-center">
            <h2 className="text-xl font-semibold tracking-tight text-ink">What are we working on?</h2>
            <p className="mt-2 text-[13.5px] text-ink-2">
              Claude Code is ready in <span className="font-mono">{projectName}</span>. It can read and
              edit files and run commands here, and will ask before anything it isn’t already
              allowed to do.
            </p>
          </div>
        )}
        {turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} />
        ))}
        {waiting && (
          <div className="flex items-center gap-2 text-[13px] text-ink-3">
            <span className="size-2 animate-pulse rounded-full bg-accent" />
            Working…
          </div>
        )}
      </div>
    </div>
  );
}
