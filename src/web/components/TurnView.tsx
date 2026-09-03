import { AlertTriangle, Info } from 'lucide-react';
import { memo } from 'react';
import type { Block, Turn } from '@/lib/transcript';
import { ActivityGroup, type ActivityBlock } from './ActivityGroup';
import Markdown from './Markdown';

type Piece = { kind: 'text'; text: string } | { kind: 'activity'; blocks: ActivityBlock[] };

function groupBlocks(blocks: Block[]): Piece[] {
  const pieces: Piece[] = [];
  let run: ActivityBlock[] = [];
  const flush = () => {
    if (run.length) pieces.push({ kind: 'activity', blocks: run });
    run = [];
  };
  for (const b of blocks) {
    if (b.type === 'text') {
      if (!b.text.trim()) continue;
      flush();
      pieces.push({ kind: 'text', text: b.text });
    } else {
      run.push(b);
    }
  }
  flush();
  return pieces;
}

export const TurnView = memo(function TurnView({ turn }: { turn: Turn }) {
  if (turn.kind === 'user') {
    return (
      <div className="rise flex justify-end">
        <div className="max-w-[min(40rem,85%)] rounded-xl rounded-br-sm border border-accent/25 bg-accent-soft px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words text-ink">
          {turn.text}
          {turn.images > 0 && (
            <div className="mt-1 text-[12px] text-ink-2">
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
  const lastActivity = pieces.map((p) => p.kind).lastIndexOf('activity');

  return (
    <div className="space-y-3">
      {pieces.map((piece, i) => {
        if (piece.kind === 'text') {
          const streamingText = turn.open && i === pieces.length - 1;
          return (
            <div key={i} className="rise rounded-xl border border-line bg-panel/80 px-4 py-3 text-[13.5px] leading-relaxed text-ink">
              <Markdown>{piece.text}</Markdown>
              {streamingText && (
                <span className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] bg-accent breathe" aria-hidden />
              )}
            </div>
          );
        }
        return (
          <ActivityGroup
            key={i}
            blocks={piece.blocks}
            live={turn.open}
            latest={i === lastActivity}
            hasTextAfter={i < pieces.length - 1}
          />
        );
      })}
    </div>
  );
});
