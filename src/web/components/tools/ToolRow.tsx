import { Check, ChevronDown, ChevronRight, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ToolBlock } from '@/lib/transcript';
import { toolDetail, toolLook, toolVerb } from './config';

type Props = {
  tool: ToolBlock;
  /** The turn is still running, so a missing result means "in progress". */
  live: boolean;
  children?: ReactNode;
  defaultOpen?: boolean;
};

export function ToolRow({ tool, live, children, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const look = toolLook(tool.name);
  const detail = toolDetail(tool);
  const running = tool.result === undefined && live;
  const expandable = Boolean(children);

  return (
    <div className="rounded-md border border-line bg-surface">
      <button
        type="button"
        onClick={() => expandable && setOpen((o) => !o)}
        aria-expanded={open}
        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] ${
          expandable ? 'cursor-pointer hover:bg-surface-2' : 'cursor-default'
        }`}
      >
        <span className={`flex size-4 shrink-0 items-center justify-center ${look.hue}`}>
          {look.icon}
        </span>
        <span className="shrink-0 font-medium text-ink">{toolVerb(tool)}</span>
        {detail && (
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2">{detail}</span>
        )}
        {!detail && <span className="flex-1" />}
        <span className="flex shrink-0 items-center gap-1.5 text-ink-3">
          {running ? (
            <span className="size-2 animate-pulse rounded-full bg-accent" title="running" />
          ) : tool.isError ? (
            <X className="size-3.5 text-danger" />
          ) : tool.result !== undefined ? (
            <Check className="size-3.5 text-ok" />
          ) : null}
          {expandable &&
            (open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />)}
        </span>
      </button>
      {open && expandable && (
        <div className="space-y-2 border-t border-line px-2.5 py-2">{children}</div>
      )}
    </div>
  );
}
