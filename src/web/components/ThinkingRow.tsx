import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { ThinkingBlock } from '@/lib/transcript';
import { seconds, useTicker } from '@/lib/useTicker';
import Markdown from './Markdown';

export function thinkingLabel(block: ThinkingBlock, now: number): string {
  if (!block.done) return block.startedAt ? `Thinking ${seconds(now - block.startedAt)}` : 'Thinking';
  if (block.durationMs) return `Thought for ${seconds(block.durationMs)}`;
  return 'Thought';
}

export function ThinkingRow({ block }: { block: ThinkingBlock }) {
  const [open, setOpen] = useState(false);
  const now = useTicker(!block.done && Boolean(block.startedAt));
  const hasText = block.thinking.trim().length > 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => hasText && setOpen((o) => !o)}
        className={`flex items-center gap-1.5 text-[13px] text-purple-300 ${
          hasText ? 'cursor-pointer hover:opacity-80' : 'cursor-default'
        }`}
      >
        <Brain className={`size-3.5 ${block.done ? '' : 'breathe'}`} />
        <span className={`font-medium ${block.done ? '' : 'breathe'}`}>{thinkingLabel(block, now)}</span>
        {hasText && (open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />)}
      </button>
      {open && hasText && (
        <div className="rise mt-1.5 ml-1.5 border-l-2 border-purple-300/50 pl-3 text-[13px] text-ink-2">
          <Markdown>{block.thinking}</Markdown>
        </div>
      )}
    </div>
  );
}
