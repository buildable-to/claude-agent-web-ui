import { AlertTriangle, Info } from 'lucide-react';
import { memo } from 'react';
import type { Turn } from '@/lib/transcript';
import Markdown from './Markdown';
import { ThinkingRow } from './ThinkingRow';
import { ToolCard } from './tools/cards';

export const TurnView = memo(function TurnView({ turn }: { turn: Turn }) {
  if (turn.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[min(42rem,85%)] rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap break-words text-ink">
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
        className={`flex items-start gap-2 rounded-md px-3 py-2 text-[13px] ${
          error ? 'bg-danger-soft text-danger' : 'bg-surface-2 text-ink-2'
        }`}
      >
        {error ? <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> : <Info className="mt-0.5 size-3.5 shrink-0" />}
        <span className="whitespace-pre-wrap break-words">{turn.text}</span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {turn.blocks.map((block, i) => {
        if (block.type === 'text') {
          return block.text.trim() ? (
            <div key={i} className="text-[14px] leading-relaxed text-ink">
              <Markdown>{block.text}</Markdown>
            </div>
          ) : null;
        }
        if (block.type === 'thinking') return <ThinkingRow key={i} block={block} />;
        return <ToolCard key={block.id} tool={block} live={turn.open} />;
      })}
    </div>
  );
});
