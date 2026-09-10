import { ArrowUp, AtSign, Eye, SlashSquare, Square, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { CommandInfo, SessionStatus } from '@shared/protocol';
import { money } from '@/lib/format';
import type { Viewing } from '@/lib/studio';
import {
  EMPTY_MENTIONS,
  insertMention,
  matchMentions,
  mentionItems,
  mentionQuery,
  type MentionItem,
  type Mentions,
} from '@/lib/mentions';
import { CommandPicker, matchCommands } from './CommandPicker';
import { MentionPicker } from './MentionPicker';
import { splitMentions } from '@/lib/mentions';
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
  /** The project's marks and elements, offered on "@" (posted in by the studio). */
  mentions?: Mentions;
  /** What is on the studio's screen; rides in front of the next message. */
  viewing?: Viewing | null;
  onDismissViewing?: () => void;
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
  mentions = EMPTY_MENTIONS,
  viewing = null,
  onDismissViewing,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [caret, setCaret] = useState(0);
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  const busy = status === 'running' || status === 'requires_action';
  const disabled = status === 'connecting';

  const query = pickerQuery(value);
  const pickerOpen = query !== null && dismissed !== value;
  const matches = useMemo(() => (query === null ? [] : matchCommands(commands, query)), [commands, query]);

  // "@" at the caret opens the marks — when the studio gave us any
  const items = useMemo(() => mentionItems(mentions), [mentions]);
  const at = items.length > 0 && !pickerOpen ? mentionQuery(value, caret) : null;
  const atOpen = at !== null && dismissed !== value;
  const atMatches = useMemo(() => (at === null ? [] : matchMentions(items, at.query)), [items, at]);

  useEffect(() => {
    setActive(0);
  }, [query, at?.query]);

  useEffect(() => {
    if (pendingCaret === null) return;
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(pendingCaret, pendingCaret);
      setCaret(pendingCaret);
    }
    setPendingCaret(null);
  }, [pendingCaret, value]);

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

  const pickMention = (it: MentionItem) => {
    if (!at) return;
    const next = insertMention(value, caret, at, it.insert);
    onChange(next.value);
    setDismissed(null);
    setPendingCaret(next.caret);
  };

  const trackCaret = () => {
    const el = ref.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (atOpen) {
      if (e.key === 'ArrowDown' && atMatches.length) {
        e.preventDefault();
        setActive((i) => (i + 1) % atMatches.length);
        return;
      }
      if (e.key === 'ArrowUp' && atMatches.length) {
        e.preventDefault();
        setActive((i) => (i - 1 + atMatches.length) % atMatches.length);
        return;
      }
      if ((e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) && atMatches.length) {
        e.preventDefault();
        pickMention(atMatches[active] ?? atMatches[0]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(value);
        return;
      }
    }
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

  // one set of metrics for the textarea and its mirror
  const field = `py-[11px] ${busy ? 'pr-[5.25rem]' : 'pr-12'} pl-4 text-[13.5px] leading-relaxed`;
  const hasMentions = /(^|\s)@[^\s@]+/.test(value);

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
        {atOpen && at && (
          <MentionPicker items={atMatches} query={at.query} activeIndex={active} onHover={setActive} onPick={pickMention} />
        )}
        {/* What is on the studio's screen, always on: the chip says what the
            next message will carry in front of it ("Looking at …"), so the
            engineer sees what the agent will be told. ✕ drops it until the
            screen changes; there is nothing to type to get it back. */}
        {viewing && (
          <div className="flex items-center gap-1.5 px-3 pt-2.5">
            <span
              title={viewing.line}
              className="flex max-w-full items-center gap-1.5 rounded-full bg-panel-2 py-0.5 pr-1 pl-2 text-[11.5px] font-medium text-ink-2"
            >
              <Eye className="size-3 shrink-0 text-ink-3" />
              <span className="text-ink-3">Looking at</span>
              <span className="truncate text-ink">{viewing.text}</span>
              {onDismissViewing && (
                <button
                  type="button"
                  onClick={onDismissViewing}
                  title="Leave this out of the next message"
                  aria-label="Leave this out of the next message"
                  className="rounded-full p-0.5 text-ink-3 hover:bg-panel-3 hover:text-ink"
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          </div>
        )}
        {/* A chosen mark should look chosen while you type, not only after
            sending. A textarea cannot colour a word, so a mirror behind it
            paints the same text with every "@mark" as a pill; the textarea's
            own text is transparent, its caret and selection are not. The two
            share one set of metrics (see `field`) so the glyphs line up. */}
        {hasMentions && (
          <div ref={mirror} aria-hidden className={`composer-mirror ${field}`}>
            {splitMentions(value).map((part, i) =>
              typeof part === 'string' ? (
                part
              ) : (
                <span key={i} className="mention-in">
                  @{part.mention}
                </span>
              ),
            )}
            {'\u200b'}
          </div>
        )}
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={onKey}
          onKeyUp={trackCaret}
          onClick={trackCaret}
          onSelect={trackCaret}
          onScroll={(e) => {
            if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop;
          }}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          title={controls ? 'Enter to send · Shift+Enter for a new line' : undefined}
          aria-autocomplete="list"
          aria-expanded={pickerOpen}
          className={`relative block w-full resize-none bg-transparent outline-none placeholder:text-ink-3 disabled:opacity-60 ${field} ${hasMentions ? 'composer-clear' : 'text-ink'}`}
        />
        <div className="absolute right-[7px] bottom-[7px] flex items-center gap-1.5">
          {busy && (
            <button
              type="button"
              onClick={onStop}
              title="Stop the current turn"
              aria-label="Stop"
              className="sendbtn bg-panel-3 text-ink hover:bg-danger hover:text-white"
            >
              <Square className="size-3" fill="currentColor" />
            </button>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={disabled || !value.trim()}
            title={busy ? 'Send a follow-up — it runs after the current step' : 'Send'}
            aria-label="Send"
            className="sendbtn active:translate-y-px"
          >
            <ArrowUp className="size-4" strokeWidth={2.5} />
          </button>
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
            {items.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  // "@" where the caret is (or at the end), then the list opens
                  const el = ref.current;
                  const pos = el ? (el.selectionStart ?? value.length) : value.length;
                  const head = value.slice(0, pos);
                  const glue = head && !/\s$/.test(head) ? ' ' : '';
                  const next = `${head}${glue}@${value.slice(pos)}`;
                  onChange(next);
                  setDismissed(null);
                  setPendingCaret(head.length + glue.length + 1);
                }}
                className="flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-ink-2 hover:bg-panel-2 hover:text-ink"
                title="Name a mark or an element — @C1"
              >
                <AtSign className="size-3.5" /> Marks
                <span className="text-ink-3">{mentions.marks.length}</span>
              </button>
            )}
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
