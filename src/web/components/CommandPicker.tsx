import { useEffect, useMemo, useRef } from 'react';
import type { CommandInfo } from '@shared/protocol';

type Props = {
  commands: CommandInfo[];
  query: string;
  activeIndex: number;
  loading: boolean;
  onHover: (i: number) => void;
  onPick: (c: CommandInfo) => void;
};

export function matchCommands(commands: CommandInfo[], query: string): CommandInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  const name = (c: CommandInfo) => c.name.toLowerCase();
  const starts = commands.filter((c) => name(c).startsWith(q));
  const inName = commands.filter((c) => !name(c).startsWith(q) && name(c).includes(q));
  // Descriptions only join in once the query is specific enough.
  const inDesc =
    q.length >= 3
      ? commands.filter((c) => !name(c).includes(q) && c.description.toLowerCase().includes(q))
      : [];
  return [...starts, ...inName, ...inDesc];
}

export function CommandPicker({ commands, query, activeIndex, loading, onHover, onPick }: Props) {
  const matches = useMemo(() => matchCommands(commands, query), [commands, query]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div className="rise absolute right-0 bottom-full left-0 z-20 mb-2 overflow-hidden rounded-lg border border-line-2 bg-panel shadow-strong">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-[11px] text-ink-3">
        <span className="font-semibold tracking-[0.14em] uppercase">Skills</span>
        <span>↑↓ to move · Enter to pick · Esc to close</span>
      </div>
      <div ref={listRef} className="max-h-72 overflow-y-auto py-1" role="listbox">
        {loading && matches.length === 0 && (
          <div className="px-3 py-3 text-[12.5px] text-ink-3">Asking the engine what it knows…</div>
        )}
        {!loading && matches.length === 0 && (
          <div className="px-3 py-3 text-[12.5px] text-ink-3">No skill matches “/{query}”.</div>
        )}
        {matches.map((c, i) => (
          <button
            key={c.name}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(c)}
            className={`flex w-full items-baseline gap-3 px-3 py-1.5 text-left ${
              i === activeIndex ? 'bg-accent-soft' : 'hover:bg-panel-2'
            }`}
          >
            <span className="shrink-0 font-mono text-[12.5px] font-medium text-accent">/{c.name}</span>
            {c.argumentHint && (
              <span className="shrink-0 font-mono text-[11px] text-ink-3">{c.argumentHint}</span>
            )}
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2">{c.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
