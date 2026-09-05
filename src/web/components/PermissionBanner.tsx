import { MessageCircleQuestion, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import type { PermissionRequest } from '@shared/protocol';

type Props = {
  request: PermissionRequest;
  queued: number;
  onAnswer: (
    requestId: string,
    behavior: 'allow' | 'deny',
    always?: boolean,
    answers?: Record<string, string>,
  ) => void;
};

type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
};

function questionsOf(r: PermissionRequest): Question[] {
  const qs = r.input.questions;
  if (!Array.isArray(qs)) return [];
  return qs
    .filter((q): q is Record<string, unknown> => typeof q === 'object' && q !== null)
    .map((q) => ({
      question: String(q.question ?? ''),
      header: typeof q.header === 'string' ? q.header : undefined,
      multiSelect: Boolean(q.multiSelect),
      options: Array.isArray(q.options)
        ? q.options
            .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
            .map((o) => ({ label: String(o.label ?? ''), description: typeof o.description === 'string' ? o.description : undefined }))
        : [],
    }))
    .filter((q) => q.question && q.options.length > 0);
}

/** The agent stopped to ask something only the engineer can decide. Options are
 *  buttons; the chosen labels go back on the tool's own input as `answers`. */
function QuestionCard({ request, queued, onAnswer }: Props) {
  const questions = questionsOf(request);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const answerFor = (q: Question) => {
    const free = other[q.question]?.trim();
    if (free) return free;
    const labels = picked[q.question] ?? [];
    return labels.length ? labels.join(', ') : '';
  };
  const complete = questions.every((q) => answerFor(q));
  const toggle = (q: Question, label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      const next = q.multiSelect
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : [label];
      return { ...p, [q.question]: next };
    });
  const submit = () => {
    const answers: Record<string, string> = {};
    for (const q of questions) answers[q.question] = answerFor(q);
    onAnswer(request.requestId, 'allow', false, answers);
  };
  const btn =
    'h-8 rounded-md px-3.5 text-[12.5px] font-semibold transition active:translate-y-px focus-visible:outline-inverse-ink';
  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      <div className="rise rounded-xl bg-inverse p-4 text-inverse-ink shadow-strong">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/25 text-accent">
            <MessageCircleQuestion className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[14px] font-semibold">The agent has a question</span>
              {queued > 0 && <span className="text-[12px] text-inverse-ink-2">+{queued} more waiting</span>}
            </div>
            <div className="mt-3 space-y-4">
              {questions.map((q) => (
                <div key={q.question}>
                  {q.header && (
                    <span className="mb-1 inline-block rounded bg-inverse-2 px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wider text-inverse-ink-2 uppercase">
                      {q.header}
                    </span>
                  )}
                  <p className="text-[13.5px] leading-snug">{q.question}</p>
                  <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                    {q.options.map((o) => {
                      const on = (picked[q.question] ?? []).includes(o.label);
                      return (
                        <button
                          key={o.label}
                          type="button"
                          onClick={() => toggle(q, o.label)}
                          aria-pressed={on}
                          className={`rounded-lg border px-3 py-2 text-left transition active:translate-y-px ${
                            on
                              ? 'border-accent bg-accent/20'
                              : 'border-inverse-ink/15 hover:bg-inverse-ink/10'
                          }`}
                        >
                          <span className="block text-[12.5px] font-semibold">{o.label}</span>
                          {o.description && (
                            <span className="mt-0.5 block text-[11.5px] leading-snug text-inverse-ink-2">
                              {o.description}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <input
                    type="text"
                    value={other[q.question] ?? ''}
                    onChange={(e) => setOther((o) => ({ ...o, [q.question]: e.target.value }))}
                    placeholder="Other…"
                    className="mt-1.5 h-8 w-full rounded-md border border-inverse-ink/15 bg-transparent px-2.5 text-[12.5px] text-inverse-ink placeholder:text-inverse-ink-2 outline-none focus:border-accent"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-3.5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => onAnswer(request.requestId, 'deny')}
            className={`${btn} border border-inverse-ink/20 text-inverse-ink hover:bg-inverse-ink/10`}
            title="Skip the question; the agent decides on its own"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!complete}
            className={`${btn} bg-accent text-white hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-50`}
          >
            Answer
          </button>
        </div>
      </div>
    </div>
  );
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function Code({ children, tone = 'plain' }: { children: string; tone?: 'plain' | 'add' | 'remove' }) {
  const tones = {
    plain: 'bg-inverse-2 text-inverse-ink',
    add: 'bg-sea/25 text-inverse-ink',
    remove: 'bg-danger/25 text-inverse-ink',
  } as const;
  return (
    <pre
      className={`max-h-56 overflow-auto rounded-lg px-3.5 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words ${tones[tone]}`}
    >
      {children}
    </pre>
  );
}

function describe(r: PermissionRequest): { title: string; body: React.ReactNode } {
  const i = r.input;
  switch (r.toolName) {
    case 'Bash':
      return {
        title: str(i.description) ?? 'run a command',
        body: <Code>{`$ ${str(i.command) ?? ''}`}</Code>,
      };
    case 'Edit':
    case 'MultiEdit':
      return {
        title: `edit ${str(i.file_path) ?? 'a file'}`,
        body: (
          <div className="space-y-1.5">
            {str(i.old_string) ? <Code tone="remove">{str(i.old_string)!}</Code> : null}
            {str(i.new_string) ? <Code tone="add">{str(i.new_string)!}</Code> : null}
          </div>
        ),
      };
    case 'Write':
      return { title: `write ${str(i.file_path) ?? 'a file'}`, body: <Code tone="add">{str(i.content) ?? ''}</Code> };
    case 'Read':
      return { title: `read ${str(i.file_path) ?? 'a file'}`, body: null };
    case 'WebFetch':
      return {
        title: `fetch ${str(i.url) ?? 'a URL'}`,
        body: str(i.prompt) ? <p className="text-[13px] text-inverse-ink-2">{str(i.prompt)}</p> : null,
      };
    case 'WebSearch':
      return { title: `search the web for “${str(i.query) ?? ''}”`, body: null };
    default:
      return {
        title: `use the ${r.toolName} tool`,
        body: Object.keys(i).length ? <Code>{JSON.stringify(i, null, 2)}</Code> : null,
      };
  }
}

/** The page goes dark when it needs you: an inverted card for the one decision that can't wait. */
export function PermissionBanner({ request, queued, onAnswer }: Props) {
  if (request.toolName === 'AskUserQuestion' && questionsOf(request).length > 0) {
    return <QuestionCard request={request} queued={queued} onAnswer={onAnswer} />;
  }
  const d = describe(request);
  const title = request.title ?? `Claude wants to ${d.title}`;
  const btn =
    'h-8 rounded-md px-3.5 text-[12.5px] font-semibold transition active:translate-y-px focus-visible:outline-inverse-ink';
  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      <div className="rise rounded-xl bg-inverse p-4 text-inverse-ink shadow-strong">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-warn/25 text-[#8a5a00]">
            <ShieldAlert className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[14px] font-semibold">{title}</span>
              {queued > 0 && <span className="text-[12px] text-inverse-ink-2">+{queued} more waiting</span>}
            </div>
            {request.description && <p className="mt-0.5 text-[12.5px] text-inverse-ink-2">{request.description}</p>}
            {request.decisionReason && (
              <p className="mt-0.5 text-[12px] text-inverse-ink-2">{request.decisionReason}</p>
            )}
            {d.body && <div className="mt-2.5">{d.body}</div>}
          </div>
        </div>
        <div className="mt-3.5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => onAnswer(request.requestId, 'deny')}
            className={`${btn} border border-inverse-ink/20 text-inverse-ink hover:bg-inverse-ink/10`}
          >
            Deny
          </button>
          {request.canAlwaysAllow && (
            <button
              type="button"
              onClick={() => onAnswer(request.requestId, 'allow', true)}
              className={`${btn} border border-inverse-ink/20 text-inverse-ink hover:bg-inverse-ink/10`}
              title="Allow this and stop asking, like “don’t ask again” in the terminal"
            >
              Always allow
            </button>
          )}
          <button
            type="button"
            onClick={() => onAnswer(request.requestId, 'allow')}
            className={`${btn} bg-accent text-white hover:bg-accent-dim`}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
