import { ArrowUp, Square } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SessionStatus } from '@shared/protocol';

type Props = {
  status: SessionStatus | 'connecting';
  onSend: (text: string) => void;
  onStop: () => void;
  autoFocus?: boolean;
};

export function ChatInput({ status, onSend, onStop, autoFocus }: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = status === 'running' || status === 'requires_action';
  const disabled = status === 'connecting';

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(240, el.scrollHeight)}px`;
  }, [text]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText('');
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-5 pt-3 pb-4">
      <div className="flex items-end gap-2 rounded-xl border border-line bg-surface px-3 py-2 focus-within:border-accent">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={
            status === 'closed'
              ? 'The engine stopped. Sending a message starts it again.'
              : busy
                ? 'Send a follow-up (it will run after the current step)…'
                : 'Message Claude… (Enter to send, Shift+Enter for a new line)'
          }
          disabled={disabled}
          rows={1}
          className="max-h-60 min-h-[24px] flex-1 resize-none bg-transparent py-1 text-[14px] leading-relaxed text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"
        />
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            title="Stop the current turn"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-danger text-white hover:opacity-90"
          >
            <Square className="size-3.5" fill="currentColor" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !text.trim()}
          title="Send"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-white hover:opacity-90 disabled:opacity-40"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </div>
  );
}
