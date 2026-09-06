import { ArrowUp, SlashSquare, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { CommandInfo, SessionStatus } from '@shared/protocol';
import { money } from '@/lib/format';
import { CommandPicker, matchCommands } from './CommandPicker';
import { SessionControls, type ControlsProps } from './SessionControls';

type Props = {
  value: string;
  onChange: (value: string) => void;
  status: SessionStatus | 'connecting';
  onSend: (text: string) => void;
  onStop: () => void;
  commands: CommandInfo[];
  commandsLoading: boolean;
  autoFocus?: boolean;
  /** Bumped by the parent when it wants the textarea focused (e.g. after inserting a path). */
  focusKey?: number;
  /** Embedded: the model and mode pickers live here, beside Skills, as quiet
   *  text menus — machinery next to the composer, not in a second title bar. */
  controls?: Omit<ControlsProps, 'look' | 'embedded'>;
};

/** The picker is open while the draft is a lone "/word" with no space yet. */
function pickerQuery(value: string): string | null {
  if (!value.startsWith('/')) return null;
  if (/\s/.test(value)) return null;
  return value.slice(1);
}

export function ChatInput({
  value,
  onChange,
  status,
  onSend,
  onStop,
  commands,
  commandsLoading,
  autoFocus,
  focusKey,
  controls,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const busy = status === 'running' || status === 'requires_action';
  const disabled = status === 'connecting';

  const query = pickerQuery(value);
  const pickerOpen = query !== null && dismissed !== value;
  const matches = useMemo(() => (query === null ? [] : matchCommands(commands, query)), [commands, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(280, Math.max(44, el.scrollHeight))}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus || focusKey) ref.current?.focus();
  }, [autoFocus, focusKey]);

  const submit = () => {
    const t = value.trim();
    if (!t || disabled) return;
    onSend(t);
    onChange('');
  };

  const pick = (c: CommandInfo) => {
    onChange(`/${c.name} `);
    setDismissed(null);
    ref.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen && matches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        pick(matches[active] ?? matches[0]!);
        return;
      }
    }
    if (pickerOpen && e.key === 'Escape') {
      e.preventDefault();
      setDismissed(value);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const placeholder =
    status === 'closed'
      ? 'The engine stopped. Send a message to start it again.'
      : busy
        ? 'Send a follow-up. It runs after the current step.'
        : 'Ask for a change, a plan, or a diagnosis… or type / for skills';

  return (
    <div className="mx-auto w-full max-w-3xl px-5 pt-2 pb-3">
      <div className="focus-glow relative rounded-[22px] border border-line-2 bg-panel shadow-strong transition">
        {pickerOpen && (
          <CommandPicker
            commands={commands}
            query={query ?? ''}
            activeIndex={active}
            loading={commandsLoading}
            onHover={setActive}
            onPick={pick}
          />
        )}
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          title={controls ? 'Enter to send · Shift+Enter for a new line' : undefined}
          aria-autocomplete="list"
          aria-expanded={pickerOpen}
          className="block w-full resize-none bg-transparent py-[11px] pr-12 pl-4 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"
        />
        <div className="absolute right-[7px] bottom-[7px]">
          {busy ? (
            <button
              type="button"
              onClick={onStop}
              title="Stop the current turn"
              className="sendbtn bg-panel-3 text-ink hover:bg-danger hover:text-white"
            >
              <Square className="size-3" fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={disabled || !value.trim()}
              title="Send"
              aria-label="Send"
              className="sendbtn active:translate-y-px"
            >
              <ArrowUp className="size-4" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3 px-2">
        <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onChange('/');
                setDismissed(null);
                ref.current?.focus();
              }}
              className="flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-ink-2 hover:bg-panel-2 hover:text-ink"
              title="Browse skills"
            >
              <SlashSquare className="size-3.5" /> Skills
              {commands.length > 0 && <span className="text-ink-3">{commands.length}</span>}
            </button>
            {controls ? (
              <SessionControls {...controls} look="text" embedded />
            ) : (
              <span className="text-[11px] text-ink-3">Enter to send · Shift+Enter for a new line</span>
            )}
          </div>
        {controls && controls.meta.totalCostUsd !== undefined && (
          <span className="font-mono text-[10.5px] text-ink-3" title="Estimated cost of this conversation">
            {money(controls.meta.totalCostUsd)}
          </span>
        )}
      </div>
    </div>
  );
}
