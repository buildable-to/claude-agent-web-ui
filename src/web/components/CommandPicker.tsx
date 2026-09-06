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
    <div className="menu-pop rise absolute right-0 bottom-full left-0 z-20 mb-2">
      <div className="menu-head flex items-center justify-between">
        <span>Skills</span>
        <span className="font-normal">↑↓ · Enter · Esc</span>
      </div>
      <div ref={listRef} className="max-h-72 overflow-y-auto" role="listbox">
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
            className={`menu-item ${i === activeIndex ? 'on' : ''}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                <span className={`font-mono text-[12.5px] font-medium ${i === activeIndex ? 'text-white' : 'text-accent'}`}>/{c.name}</span>
                {c.argumentHint && <span className="ml-2 font-mono text-[11px] opacity-70">{c.argumentHint}</span>}
              </span>
              <span className="menu-hint one" title={c.description}>{c.description.split(/(?<=\.)\s/)[0]}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
