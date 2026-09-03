import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { ThinkingBlock } from '@/lib/transcript';
import Markdown from './Markdown';

export function ThinkingRow({ block }: { block: ThinkingBlock }) {
  const [open, setOpen] = useState(false);
  const hasText = block.thinking.trim().length > 0;
  const seconds = block.durationMs ? Math.max(1, Math.round(block.durationMs / 1000)) : null;
  const label = !block.done ? 'Thinking' : seconds ? `Thought for ${seconds}s` : 'Thought';

  return (
    <div>
      <button
        type="button"
        onClick={() => hasText && setOpen((o) => !o)}
        className={`flex items-center gap-1.5 text-[12.5px] text-ink-3 ${
          hasText ? 'cursor-pointer hover:text-ink-2' : 'cursor-default'
        }`}
      >
        <Brain className={`size-3.5 ${block.done ? '' : 'animate-pulse text-accent'}`} />
        <span className={block.done ? '' : 'animate-pulse'}>{label}</span>
        {hasText && (open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />)}
      </button>
      {open && hasText && (
        <div className="mt-1.5 ml-2 border-l-2 border-line pl-3 text-ink-2">
          <Markdown>{block.thinking}</Markdown>
        </div>
      )}
    </div>
  );
}
