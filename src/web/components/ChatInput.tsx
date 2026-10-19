import { page } from '@/lib/page';
import { ArrowUp, AtSign, Bell, BellOff, Eye, EyeOff, FileText, Loader2, Paperclip, SlashSquare, Square, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { Attachment, CommandInfo, SessionStatus } from '@shared/protocol';
import { api } from '@/lib/api';
import { fileSize, MAX_FILE_BYTES, MAX_FILES, shrinkPicture, transferFiles } from '@/lib/attachments';
import type { ToolImage } from '@/lib/transcript';
import { Lightbox } from './Lightbox';
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
  /** The words, the files attached beside them (already uploaded), and how
   *  the pictures among them look. */
  onSend: (text: string, files: Attachment[], pictures: ToolImage[]) => void;
  onStop: () => void;
  /** Sub-agents or backgrounded commands still run after the turn: Stop stays. */
  backgroundWork?: boolean;
  /** The line to the server is up; a Stop sent without it would fire later, on whatever runs then. */
  connected?: boolean;
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
  /** The engineer dropped the chip (✕); a small eye-off brings it back. */
  viewingDismissed?: boolean;
  onRestoreViewing?: () => void;
  /** Click the chip: the studio frames what it names. */
  onShowViewing?: () => void;
  /** The chime when the agent needs you: on or off in this browser, and the
   *  bell that switches it. */
  chime?: boolean;
  onChime?: () => void;
};

/** A file on its way into the next message. */
type Attached = { key: string; name: string; size: number; picture?: ToolImage; file?: Attachment };

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
  backgroundWork = false,
  connected = true,
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
  viewingDismissed = false,
  onRestoreViewing,
  onShowViewing,
  chime = true,
  onChime,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [caret, setCaret] = useState(0);
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  /** Files for the next message, in the order attached; `file` is set once
   *  the upload is done, and Send waits for every one. */
  const [attached, setAttached] = useState<Attached[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [shown, setShown] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = attached.some((a) => !a.file);
  const pictures = attached.filter((a) => a.picture).map((a) => a.picture!);
  const busy = status === 'running' || status === 'requires_action';
  const stoppable = busy || backgroundWork;
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
    if ((!t && !attached.length) || disabled || uploading) return;
    onSend(t, attached.map((a) => a.file!), pictures);
    onChange('');
    setAttached([]);
    setAttachError(null);
  };

  const attach = (files: File[]) => {
    setAttachError(null);
    const room = MAX_FILES - attached.length;
    if (files.length > room) setAttachError(`At most ${MAX_FILES} files in one message`);
    for (const file of files.slice(0, Math.max(0, room))) {
      if (file.size > MAX_FILE_BYTES) {
        setAttachError(`${file.name} is too large to attach (95 MB at most)`);
        continue;
      }
      const key = crypto.randomUUID();
      setAttached((as) => [...as, { key, name: file.name || 'file', size: file.size }]);
      void (async () => {
        try {
          const shrunk = file.type.startsWith('image/') ? await shrinkPicture(file) : null;
          const body = shrunk?.blob ?? file;
          const name = shrunk?.name ?? (file.name || 'file');
          if (shrunk) {
            const picture = { mediaType: shrunk.mediaType, data: shrunk.data };
            setAttached((as) => as.map((a) => (a.key === key ? { ...a, picture } : a)));
          }
          const uploaded = await api.attach(body, name);
          setAttached((as) => as.map((a) => (a.key === key ? { ...a, file: uploaded } : a)));
        } catch (err) {
          setAttached((as) => as.filter((a) => a.key !== key));
          setAttachError(`${file.name || 'The file'} could not be attached: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    }
    ref.current?.focus();
  };

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

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
  const field = `py-[11px] ${stoppable ? 'pr-[5.25rem]' : 'pr-12'} pl-4 text-[13.5px] leading-relaxed`;
  const hasMentions = /(^|\s)@[A-Za-z][^\s@]*/.test(value);

  const placeholder =
    status === 'closed'
      ? 'The engine stopped. Send a message to start it again.'
      : busy
        ? 'Send a follow-up. It runs after the current step.'
        : 'Ask for a change, a plan, or a diagnosis… or type / for skills';

  return (
    <div className="mx-auto w-full max-w-3xl px-5 pt-2 pb-3 max-sm:px-3">
      <div
        className={`focus-glow relative rounded-[22px] border bg-panel shadow-strong transition ${dragging ? 'border-ink-2' : 'border-line-2'}`}
        onDragOver={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragging(false);
          const files = transferFiles(e.dataTransfer);
          if (files.length) attach(files);
        }}
      >
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
            engineer sees what the agent will be told. The words are a button
            — click, and the studio frames what they name (the answer to
            "what does it think I am looking at"). ✕ drops it until the screen
            changes; the eye-off it leaves behind brings it back. A new screen
            re-keys the chip, so it rises in afresh and the change is seen. */}
        {viewing && (
          <div key={viewing.text} className="viewing-in flex items-center gap-1.5 px-3 pt-2.5">
            <span
              title={viewing.line}
              className="flex max-w-full items-center gap-1.5 rounded-full bg-panel-2 py-0.5 pr-1 pl-2 text-[12px] font-medium text-ink-2"
            >
              <Eye className="size-3 shrink-0 text-ink-3" />
              <span className="shrink-0 text-ink-3">Looking at</span>
              <button
                type="button"
                onClick={onShowViewing}
                disabled={!onShowViewing}
                title="Show it in the studio"
                className="viewing-text min-w-0 truncate text-ink hover:underline disabled:no-underline"
              >
                {viewing.text}
              </button>
              {onDismissViewing && (
                <button
                  type="button"
                  onClick={onDismissViewing}
                  title="Leave this out of the next message"
                  aria-label="Leave this out of the next message"
                  className="shrink-0 rounded-full p-0.5 text-ink-3 hover:bg-panel-3 hover:text-ink"
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          </div>
        )}
        {!viewing && viewingDismissed && onRestoreViewing && (
          <div className="flex items-center px-3 pt-2.5">
            <button
              type="button"
              onClick={onRestoreViewing}
              title="Put what you are looking at back in front of the next message"
              aria-label="Put what you are looking at back in front of the next message"
              className="flex items-center gap-1 rounded-full py-0.5 pr-2 pl-1.5 text-[11.5px] text-ink-3 hover:bg-panel-2 hover:text-ink"
            >
              <EyeOff className="size-3" />
              <span>not saying what you look at</span>
            </button>
          </div>
        )}
        {/* Files attached (paperclip, Ctrl+V or a drop) ride with the next
            message. Pictures show as themselves — click one to see it large;
            other files as their name and size. */}
        {(attached.length > 0 || attachError) && (
          <div className="flex flex-wrap items-center gap-2 px-3 pt-2.5">
            {attached.map((a) => (
              <span key={a.key} className="relative">
                {a.picture ? (
                  <button
                    type="button"
                    onClick={() => setShown(pictures.indexOf(a.picture!))}
                    title={a.name}
                    className="block size-14 overflow-hidden rounded-lg border border-line-2 bg-panel-2"
                  >
                    <img src={`data:${a.picture.mediaType};base64,${a.picture.data}`} alt={a.name} className="size-full object-cover" />
                  </button>
                ) : (
                  <span
                    title={a.name}
                    className="flex h-14 max-w-56 items-center gap-2 rounded-lg border border-line-2 bg-panel-2 pr-3 pl-2.5"
                  >
                    <FileText className="size-4 shrink-0 text-ink-3" />
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] font-medium text-ink">{a.name}</span>
                      <span className="block text-[11px] text-ink-3">{fileSize(a.size)}</span>
                    </span>
                  </span>
                )}
                {!a.file && (
                  <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/45 text-white">
                    <Loader2 className="size-4 animate-spin" />
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setAttached((as) => as.filter((x) => x.key !== a.key))}
                  title="Leave this file out"
                  aria-label={`Leave ${a.name} out`}
                  className="absolute -top-1.5 -right-1.5 rounded-full border border-line-2 bg-panel-3 p-0.5 text-ink-2 hover:text-ink"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            {attachError && <span className="text-[11.5px] text-danger">{attachError}</span>}
          </div>
        )}
        {shown !== null && pictures.length > 0 && (
          <Lightbox
            pictures={pictures.map((image) => ({ image }))}
            index={Math.min(Math.max(0, shown), pictures.length - 1)}
            onClose={() => setShown(null)}
          />
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
          onPaste={(e) => {
            const files = transferFiles(e.clipboardData, true);
            if (!files.length) return;
            e.preventDefault();
            attach(files);
          }}
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
          {stoppable && (
            <button
              type="button"
              onClick={onStop}
              disabled={!connected}
              title={
                !connected
                  ? 'Reconnecting — Stop comes back when the connection does'
                  : busy
                    ? 'Stop the current turn'
                    : 'Stop the work still running in the background'
              }
              aria-label="Stop"
              className="sendbtn bg-panel-3 text-ink hover:bg-danger hover:text-white"
            >
              <Square className="size-3" fill="currentColor" />
            </button>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={disabled || uploading || (!value.trim() && !attached.length)}
            title={busy ? 'Send a follow-up — it runs after the current step' : 'Send'}
            aria-label="Send"
            className="sendbtn active:translate-y-px"
          >
            <ArrowUp className="size-4" strokeWidth={2.5} />
          </button>
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3 px-2">
        {/* on a phone the row wraps: Skills · Marks · bell, then the two pickers */}
        <div className="flex flex-wrap items-center gap-2">
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
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-ink-2 hover:bg-panel-2 hover:text-ink"
              title="Attach files — or paste with Ctrl+V, or drop them on the box"
            >
              <Paperclip className="size-3.5" /> Attach
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.currentTarget.files ?? []);
                e.currentTarget.value = '';
                if (files.length) attach(files);
              }}
            />
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
            {onChime && (
              <button
                type="button"
                onClick={onChime}
                aria-pressed={chime}
                aria-label="Chime when the agent needs you"
                title={
                  chime
                    ? 'A chime when the agent needs you — click to turn it off'
                    : 'No chime when the agent needs you — click to turn it on'
                }
                className={`flex h-7 items-center rounded-md px-2 hover:bg-panel-2 hover:text-ink ${chime ? 'text-ink-2' : 'text-ink-3'}`}
              >
                {chime ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
              </button>
            )}
            {controls ? (
              <SessionControls {...controls} look="text" embedded />
            ) : (
              <span className="text-[11px] text-ink-3">Enter to send · Shift+Enter for a new line</span>
            )}
          </div>
        {/* no price inside a studio: the engineer is not shown what a chat
            costs (ezdxf-flask #723, Luka 2026-10-12) */}
        {controls && controls.meta.totalCostUsd !== undefined && !page.embed && (
          <span className="font-mono text-[10.5px] text-ink-3 max-sm:hidden" title="Estimated cost of this conversation">
            {money(controls.meta.totalCostUsd)}
          </span>
        )}
      </div>
    </div>
  );
}
