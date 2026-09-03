import { ShieldAlert } from 'lucide-react';
import type { PermissionRequest } from '@shared/protocol';
import { Pre } from './tools/pieces';

type Props = {
  request: PermissionRequest;
  queued: number;
  onAnswer: (requestId: string, behavior: 'allow' | 'deny', always?: boolean) => void;
};

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function describe(r: PermissionRequest): { title: string; body: React.ReactNode } {
  const i = r.input;
  switch (r.toolName) {
    case 'Bash':
      return {
        title: str(i.description) ?? 'Run a shell command',
        body: <Pre maxHeight>$ {str(i.command) ?? ''}</Pre>,
      };
    case 'Edit':
    case 'MultiEdit':
      return {
        title: `Edit ${str(i.file_path) ?? 'a file'}`,
        body: (
          <div className="space-y-1">
            {str(i.old_string) ? <Pre tone="remove">{str(i.old_string)}</Pre> : null}
            {str(i.new_string) ? <Pre tone="add">{str(i.new_string)}</Pre> : null}
          </div>
        ),
      };
    case 'Write':
      return {
        title: `Write ${str(i.file_path) ?? 'a file'}`,
        body: <Pre tone="add">{str(i.content) ?? ''}</Pre>,
      };
    case 'Read':
      return { title: `Read ${str(i.file_path) ?? 'a file'}`, body: null };
    case 'WebFetch':
      return { title: `Fetch ${str(i.url) ?? 'a URL'}`, body: str(i.prompt) ? <p className="text-[13px] text-ink-2">{str(i.prompt)}</p> : null };
    case 'WebSearch':
      return { title: `Search the web for “${str(i.query) ?? ''}”`, body: null };
    default:
      return {
        title: `Use the ${r.toolName} tool`,
        body: Object.keys(i).length ? <Pre>{JSON.stringify(i, null, 2)}</Pre> : null,
      };
  }
}

export function PermissionBanner({ request, queued, onAnswer }: Props) {
  const d = describe(request);
  const title = request.title ?? d.title;
  return (
    <div className="mx-auto w-full max-w-3xl px-5">
      <div className="rounded-lg border border-warn bg-warn-soft p-3">
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[13.5px] font-semibold text-ink">Claude wants to: {title}</span>
              {queued > 0 && (
                <span className="text-[12px] text-ink-2">+{queued} more waiting</span>
              )}
            </div>
            {request.description && <p className="mt-0.5 text-[12.5px] text-ink-2">{request.description}</p>}
            {request.decisionReason && (
              <p className="mt-0.5 text-[12px] text-ink-3">{request.decisionReason}</p>
            )}
            {d.body && <div className="mt-2">{d.body}</div>}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => onAnswer(request.requestId, 'deny')}
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-surface-2"
          >
            Deny
          </button>
          {request.canAlwaysAllow && (
            <button
              type="button"
              onClick={() => onAnswer(request.requestId, 'allow', true)}
              className="rounded-md border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-surface-2"
              title="Allow this and stop asking for it, like “don’t ask again” in the terminal"
            >
              Always allow
            </button>
          )}
          <button
            type="button"
            onClick={() => onAnswer(request.requestId, 'allow')}
            className="rounded-md bg-warn px-3.5 py-1.5 text-[13px] font-semibold text-white hover:opacity-90"
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
