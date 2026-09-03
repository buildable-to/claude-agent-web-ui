// A run of tool calls and thinking, shown as a row of chips that expands into
// a timeline. Auto-opens while Claude is working on it. Pattern adapted from
// ninehills/claude-agent-ui (MIT).
import { Brain, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import type { ThinkingBlock, ToolBlock } from '@/lib/transcript';
import { seconds, useTicker } from '@/lib/useTicker';
import { ThinkingRow, thinkingLabel } from './ThinkingRow';
import { ToolCard } from './tools/cards';
import { thinkingChip, toolChip, toolChipLabel, toolLook } from './tools/config';

export type ActivityBlock = ToolBlock | ThinkingBlock;

type Props = {
  blocks: ActivityBlock[];
  /** Turn still running. */
  live: boolean;
  /** This is the last group in the turn. */
  latest: boolean;
  /** Text follows this group inside the same turn. */
  hasTextAfter: boolean;
};

function ToolChip({ tool, live, onClick }: { tool: ToolBlock; live: boolean; onClick: () => void }) {
  const running = live && tool.result === undefined;
  const now = useTicker(running && Boolean(tool.startedAt));
  const elapsed =
    tool.startedAt && tool.endedAt
      ? seconds(tool.endedAt - tool.startedAt)
      : running && tool.startedAt
        ? seconds(now - tool.startedAt)
        : null;
  const look = toolLook(tool.name);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-[3px] font-mono text-[11px] font-medium transition active:translate-y-px ${toolChip(tool.name)} ${
        running ? 'breathe' : ''
      }`}
      title={`${tool.name}${tool.isError ? ' (failed)' : ''}`}
    >
      <span className="flex size-3 items-center justify-center [&>svg]:size-3">{look.icon}</span>
      <span className="truncate">{toolChipLabel(tool)}</span>
      {elapsed && <span className="font-mono text-[10.5px] tabular-nums opacity-80">{elapsed}</span>}
      {tool.isError && <span className="size-1.5 rounded-full bg-danger" />}
    </button>
  );
}

function ThinkChip({ block, onClick }: { block: ThinkingBlock; onClick: () => void }) {
  const now = useTicker(!block.done && Boolean(block.startedAt));
  const label = block.done
    ? block.durationMs
      ? seconds(block.durationMs)
      : 'Thought'
    : thinkingLabel(block, now);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-[3px] font-mono text-[11px] font-medium transition active:translate-y-px ${thinkingChip} ${
        block.done ? '' : 'breathe'
      }`}
      title="Thinking"
    >
      <Brain className="size-3" />
      <span>{label}</span>
    </button>
  );
}

export function ActivityGroup({ blocks, live, latest, hasTextAfter }: Props) {
  const [manual, setManual] = useState<boolean | null>(null);
  const auto = latest && live && !hasTextAfter;
  const open = manual ?? auto;
  const toggle = () => setManual(!open);
  const running = live && blocks.some((b) => (b.type === 'tool_use' ? b.result === undefined : !b.done));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {blocks.map((b, i) =>
          b.type === 'thinking' ? (
            <ThinkChip key={`t-${i}`} block={b} onClick={toggle} />
          ) : (
            <ToolChip key={b.id} tool={b} live={live} onClick={toggle} />
          ),
        )}
        <button
          type="button"
          onClick={toggle}
          className="ml-0.5 flex size-6 items-center justify-center rounded-md text-ink-3 hover:bg-panel-2 hover:text-ink"
          aria-expanded={open}
          title={open ? 'Hide details' : 'Show details'}
        >
          {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
      </div>
      {open && (
        <div className={`rise relative mt-2.5 ml-2 border-l-2 pl-4 ${running ? 'border-accent/40' : 'border-line-2'}`}>
          <div className="space-y-2">
            {blocks.map((b, i) =>
              b.type === 'thinking' ? (
                <ThinkingRow key={`t-${i}`} block={b} />
              ) : (
                <ToolCard key={b.id} tool={b} live={live} />
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
