// One popover menu for every picker in the page — the conversation, the
// model, the permission mode. A native <select> is drawn by the OS and looks
// like nothing else here; this one looks like the folder window beside it:
// glass, a check on the chosen item, the highlight in Mac blue, arrows and
// Enter and Escape as expected.
import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type React from 'react';

export type MenuItem = {
  value: string;
  label: string;
  /** One quiet line under the label. */
  hint?: string;
  /** A short thing at the right edge, e.g. "26m ago". */
  right?: string;
};

type Props = {
  items: MenuItem[];
  value?: string;
  onPick: (value: string) => void;
  /** What the closed menu shows. */
  children: ReactNode;
  disabled?: boolean;
  title?: string;
  /** Where the list opens relative to the trigger. */
  direction?: 'down' | 'up';
  align?: 'left' | 'center' | 'right';
  /** Trigger look: a quiet word with a caret, or a pill. */
  look?: 'text' | 'pill';
  /** Extra classes on the trigger. */
  className?: string;
  /** A small title row inside the list. */
  head?: string;
  wide?: boolean;
};

export function Menu({
  items,
  value,
  onPick,
  children,
  disabled,
  title,
  direction = 'down',
  align = 'left',
  look = 'text',
  className = '',
  head,
  wide,
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const trigger = useRef<HTMLButtonElement>(null);
  const close = (backToTrigger = true) => {
    setOpen(false);
    if (backToTrigger) trigger.current?.focus();
  };

  // Opening: start on the chosen item, take the keyboard. Once — every later
  // arrow or hover moves `active` and must not snap it back.
  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, items.findIndex((i) => i.value === value)));
    list.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  // Keys are handled on the popover itself, which has focus while it is open,
  // so the composer's own Enter never fires at the same time.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (items.length ? (i + 1) % items.length : 0)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (items.length ? (i - 1 + items.length) % items.length : 0)); }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); e.stopPropagation();
      const it = items[active];
      if (it) { onPick(it.value); close(); }
    }
    if (e.key === 'Tab') close(false);
  };

  const pos =
    (direction === 'up' ? 'bottom-full mb-1.5 ' : 'top-full mt-1.5 ') +
    (align === 'center' ? 'left-1/2 -translate-x-1/2' : align === 'right' ? 'right-0' : 'left-0');

  return (
    <div ref={root} className="relative inline-block max-w-full">
      <button
        ref={trigger}
        type="button"
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className={`${look === 'pill' ? 'pill' : 'menu-btn'} ${open ? 'is-open' : ''} ${className}`}
      >
        <span className="min-w-0 truncate">{children}</span>
        <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden />
      </button>
      {open && (
        <div
          ref={list}
          role="listbox"
          tabIndex={-1}
          onKeyDown={onKey}
          className={`menu-pop rise absolute z-30 outline-none ${pos} ${wide ? 'w-[22rem]' : 'min-w-[13rem]'} max-w-[min(26rem,90vw)]`}
        >
          {head && <div className="menu-head">{head}</div>}
          {items.map((it, i) => {
            const on = i === active;
            const chosen = it.value === value;
            return (
              <button
                key={it.value || '∅'}
                type="button"
                role="option"
                aria-selected={chosen}
                data-i={i}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onPick(it.value); close(); }}
                className={`menu-item ${on ? 'on' : ''}`}
              >
                <span className="menu-check">{chosen && <Check className="size-3.5" strokeWidth={2.5} />}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{it.label}</span>
                  {it.hint && <span className="menu-hint">{it.hint}</span>}
                </span>
                {it.right && <span className="menu-right">{it.right}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
