import type { ReactNode } from 'react';

export function Pre({
  children,
  tone = 'plain',
  maxHeight = true,
}: {
  children: ReactNode;
  tone?: 'plain' | 'error' | 'add' | 'remove';
  maxHeight?: boolean;
}) {
  const tones = {
    plain: 'bg-surface-2 text-ink',
    error: 'bg-danger-soft text-danger',
    add: 'bg-ok-soft text-ok',
    remove: 'bg-danger-soft text-danger',
  } as const;
  return (
    <pre
      className={`overflow-x-auto rounded-md px-3 py-2 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-words ${tones[tone]} ${
        maxHeight ? 'max-h-80 overflow-y-auto' : ''
      }`}
    >
      {children}
    </pre>
  );
}

export function FilePath({ path }: { path: string }) {
  return (
    <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-ink-2 break-all">
      {path}
    </code>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-medium tracking-wide text-ink-3 uppercase">{children}</div>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded border border-line px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-ink-2 uppercase">
      {children}
    </span>
  );
}
