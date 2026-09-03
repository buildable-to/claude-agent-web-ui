import { ArrowUp, Square } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { SessionStatus } from '@shared/protocol';

type Props = {
  value: string;
  onChange: (value: string) => void;
  status: SessionStatus | 'connecting';
  onSend: (text: string) => void;
  onStop: () => void;
  autoFocus?: boolean;
  /** Bumped by the parent when it wants the textarea focused (e.g. after inserting a path). */
  focusKey?: number;
};

export function ChatInput({ value, onChange, status, onSend, onStop, autoFocus, focusKey }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = status === 'running' || status === 'requires_action';
  const disabled = status === 'connecting';

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

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
        : 'Ask for a change, a plan, or a diagnosis…';

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pt-3 pb-4">
      <div className="focus-glow rounded-lg border border-line-2 bg-panel shadow-strong transition">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="block w-full resize-none bg-transparent px-4 pt-3 pb-1.5 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"
        />
        <div className="flex items-center justify-between gap-3 px-2.5 pb-2.5">
          <span className="pl-1.5 text-[11px] text-ink-3">
            Enter to send · Shift+Enter for a new line
          </span>
          <div className="flex items-center gap-2">
            {busy && (
              <button
                type="button"
                onClick={onStop}
                title="Stop the current turn"
                className="flex h-7.5 items-center gap-1.5 rounded-md border border-line-2 px-3 text-[12px] font-medium text-ink hover:border-danger hover:text-danger"
              >
                <Square className="size-3" fill="currentColor" /> Stop
              </button>
            )}
            <button
              type="button"
              onClick={submit}
              disabled={disabled || !value.trim()}
              title="Send"
              className="flex h-7.5 items-center gap-1.5 rounded-md pr-2.5 pl-3 text-[12px] font-semibold transition active:translate-y-px enabled:bg-accent enabled:text-white enabled:hover:bg-accent-dim disabled:cursor-default disabled:border disabled:border-line-2 disabled:bg-panel-2 disabled:text-ink-3"
            >
              Send <ArrowUp className="size-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
