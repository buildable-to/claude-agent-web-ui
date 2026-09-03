import { ShieldAlert } from 'lucide-react';
import type { PermissionRequest } from '@shared/protocol';

type Props = {
  request: PermissionRequest;
  queued: number;
  onAnswer: (requestId: string, behavior: 'allow' | 'deny', always?: boolean) => void;
};

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function Code({ children, tone = 'plain' }: { children: string; tone?: 'plain' | 'add' | 'remove' }) {
  const tones = {
    plain: 'bg-inverse-2 text-inverse-ink',
    add: 'bg-sea/25 text-inverse-ink',
    remove: 'bg-danger/25 text-inverse-ink',
  } as const;
  return (
    <pre
      className={`max-h-56 overflow-auto rounded-xl px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-words ${tones[tone]}`}
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
  const d = describe(request);
  const title = request.title ?? `Claude wants to ${d.title}`;
  const btn =
    'h-9 rounded-full px-4 text-[13px] font-semibold transition active:translate-y-px focus-visible:outline-inverse-ink';
  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      <div className="rise rounded-2xl bg-inverse p-4 text-inverse-ink shadow-strong">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-warn/20 text-warn">
            <ShieldAlert className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[14.5px] font-semibold">{title}</span>
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
            className={`${btn} bg-accent text-white shadow-soft hover:brightness-105`}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
