import { AlertTriangle, Info } from 'lucide-react';
import { memo } from 'react';
import { NO_RESPONSE, type Block, type ToolBlock, type Turn } from '@/lib/transcript';
import Markdown from './Markdown';
import { Steps } from './Steps';

/** Plumbing the engineer has no use for: a skill loading is not a step, nor
 *  is the engine fetching one of its own tool definitions. */
const HIDDEN_TOOLS = new Set(['Skill', 'ToolSearch']);

type Piece = { kind: 'text'; text: string } | { kind: 'steps'; blocks: ToolBlock[] };

/** The agent's words, and between them the stretches of work. */
function groupBlocks(blocks: Block[]): Piece[] {
  const pieces: Piece[] = [];
  let run: ToolBlock[] = [];
  const flush = () => {
    if (run.length) pieces.push({ kind: 'steps', blocks: run });
    run = [];
  };
  for (const b of blocks) {
    if (b.type === 'text') {
      const text = b.text.trim();
      if (!text || text === NO_RESPONSE) continue;
      flush();
      pieces.push({ kind: 'text', text: b.text });
    } else if (!HIDDEN_TOOLS.has(b.name)) {
      run.push(b);
    }
  }
  flush();
  return pieces;
}

export const TurnView = memo(function TurnView({ turn }: { turn: Turn }) {
  if (turn.kind === 'user') {
    return (
      <div className="rise flex justify-end pl-10">
        <div className="max-w-[min(34rem,78%)] rounded-[18px] rounded-br-[5px] bg-bubble px-3.5 py-2 text-[13.5px] leading-[1.5] whitespace-pre-wrap break-words text-white shadow-[0_1px_2px_rgba(0,0,0,.25)]">
          {turn.text}
          {turn.images > 0 && (
            <div className="mt-1 text-[12px] text-white/70">
              {turn.images} image{turn.images === 1 ? '' : 's'} attached
            </div>
          )}
        </div>
      </div>
    );
  }

  if (turn.kind === 'note') {
    const error = turn.level === 'error';
    return (
      <div
        className={`rise flex items-start gap-2 rounded-lg px-3.5 py-2.5 text-[12.5px] ${
          error ? 'bg-danger-soft text-danger' : 'bg-panel-2 text-ink-2'
        }`}
      >
        {error ? <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> : <Info className="mt-0.5 size-3.5 shrink-0" />}
        <span className="whitespace-pre-wrap break-words">{turn.text}</span>
      </div>
    );
  }

  const pieces = groupBlocks(turn.blocks);

  // The agent speaks without a box: its mark at the left, its words as text,
  // the stretches of work as one quiet line between them.
  return (
    <div className="flex gap-3 pr-6">
      <span
        className="mt-[3px] grid size-5 shrink-0 place-items-center rounded-full bg-panel-2 text-accent"
        aria-hidden
      >
        <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
          <path d="M12 3l1.9 5.6 5.6 1.9-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z" />
        </svg>
      </span>
      <div className="min-w-0 flex-1 space-y-2.5">
        {pieces.map((piece, i) => {
          if (piece.kind === 'text') {
            const streamingText = turn.open && i === pieces.length - 1;
            return (
              <div key={i} className="rise text-[13.5px] leading-[1.6] text-ink">
                <Markdown>{piece.text}</Markdown>
                {streamingText && (
                  <span className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] bg-accent breathe" aria-hidden />
                )}
              </div>
            );
          }
          return <Steps key={i} blocks={piece.blocks} live={turn.open} />;
        })}
      </div>
    </div>
  );
});
