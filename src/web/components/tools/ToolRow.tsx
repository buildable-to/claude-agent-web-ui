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
    <div className="rounded-lg border border-line bg-panel/80">
      <button
        type="button"
        onClick={() => expandable && setOpen((o) => !o)}
        aria-expanded={open}
        className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[12.5px] transition ${
          expandable ? 'cursor-pointer hover:bg-panel-2/70' : 'cursor-default'
        }`}
      >
        <span className={`flex size-4 shrink-0 items-center justify-center ${look.hue}`}>{look.icon}</span>
        <span className="shrink-0 font-medium text-ink">{toolVerb(tool)}</span>
        {detail ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2">{detail}</span>
        ) : (
          <span className="flex-1" />
        )}
        <span className="flex shrink-0 items-center gap-2 text-ink-3">
          {running ? (
            <span className="flex items-center gap-1.5 text-[11px] text-accent">
              <span className="size-2 rounded-full bg-accent breathe" />
              running
            </span>
          ) : tool.isError ? (
            <X className="size-3.5 text-danger" />
          ) : tool.result !== undefined ? (
            <Check className="size-3.5 text-sea" />
          ) : null}
          {expandable &&
            (open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />)}
        </span>
      </button>
      {open && expandable && (
        <div className="rise space-y-2 border-t border-line px-3 py-2.5">{children}</div>
      )}
    </div>
  );
}
