import { useEffect, useRef } from 'react';
import type { MentionItem } from '@/lib/mentions';

type Props = {
  items: MentionItem[];
  query: string;
  activeIndex: number;
  onHover: (i: number) => void;
  onPick: (item: MentionItem) => void;
};

/** The "@" list above the composer: marks first, then the library. */
export function MentionPicker({ items, query, activeIndex, onHover, onPick }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);
  return (
    <div className="menu-pop rise absolute right-0 bottom-full left-0 z-20 mb-2">
      <div className="menu-head flex items-center justify-between">
        <span>Marks</span>
        <span className="font-normal">↑↓ · Enter · Esc</span>
      </div>
      <div ref={listRef} role="listbox" className="max-h-64 overflow-y-auto">
        {items.length === 0 && (
          <div className="px-3 py-3 text-[12.5px] text-ink-3">Nothing here is called “{query}”.</div>
        )}
        {items.map((it, i) => (
          <button
            key={it.key}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(it)}
            className={`menu-item ${i === activeIndex ? 'on' : ''}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                <span className={`font-mono text-[12.5px] font-medium ${i === activeIndex ? 'text-white' : 'text-accent'}`}>
                  {it.label}
                </span>
              </span>
              <span className="menu-hint one">{it.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
