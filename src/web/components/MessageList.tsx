import { useEffect, useRef } from 'react';
import type { SessionStatus } from '@shared/protocol';
import type { Turn } from '@/lib/transcript';
import { TurnView } from './TurnView';

type Props = {
  turns: Turn[];
  status: SessionStatus | 'connecting';
  loading: boolean;
  projectName: string;
  onSuggest: (text: string) => void;
};

const SNAP_PX = 64;

const SUGGESTIONS = [
  'Walk me through how this project is structured',
  'Find the riskiest code here and explain why',
  'Run the tests and fix whatever fails',
];

function Skeleton() {
  return (
    <div className="space-y-4 pt-2" aria-label="Loading conversation">
      <div className="ml-auto h-10 w-2/5 rounded-2xl bg-panel-2 breathe" />
      <div className="h-24 w-4/5 rounded-2xl bg-panel-2 breathe" />
      <div className="h-8 w-1/2 rounded-xl bg-panel-2 breathe" />
    </div>
  );
}

function Dots() {
  return (
    <span className="inline-flex gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 rounded-full bg-accent breathe"
          style={{ animationDelay: `${i * 200}ms` }}
        />
      ))}
    </span>
  );
}

export function MessageList({ turns, status, loading, projectName, onSuggest }: Props) {
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
  const starting = status === 'starting';
  const waiting =
    status === 'running' && (!last || last.kind !== 'assistant' || last.blocks.length === 0);

  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 px-6 py-6">
        {loading && <Skeleton />}

        {!loading && turns.length === 0 && (
          <div className="rise pt-16">
            <div className="rounded-3xl border border-line bg-panel/80 px-8 py-10 text-center shadow-soft">
              <p className="text-[11px] font-semibold tracking-[0.3em] text-ink-3 uppercase">
                Claude Code · {projectName}
              </p>
              <h2 className="font-display mt-3 text-[30px] leading-tight font-semibold text-ink text-balance">
                What are we building?
              </h2>
              <p className="mx-auto mt-3 max-w-md text-[14px] leading-relaxed text-ink-2">
                Claude can read and edit files and run commands in this project. It asks before
                anything it isn’t already allowed to do.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onSuggest(s)}
                    className="pill text-[12.5px] hover:bg-panel-2 active:translate-y-px"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} />
        ))}

        {starting && (
          <div className="rise flex items-center gap-2.5 text-[13px] text-ink-2">
            <Dots />
            Starting Claude Code…
          </div>
        )}
        {waiting && (
          <div className="rise flex items-center gap-2.5 text-[13px] text-ink-2">
            <Dots />
            Thinking…
          </div>
        )}
      </div>
    </div>
  );
}
