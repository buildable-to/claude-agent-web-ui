// One line per stretch of work: "Working · <what it is doing now>" while the
// turn runs, "N steps" once it is done. Opens into the plain-words list of
// steps (each opens into its command and result). Pictures the steps produced
// show without opening anything: the agent looked, the engineer looks too.
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { baseName } from '@/lib/format';
import type { ToolBlock, ToolImage } from '@/lib/transcript';
import { ToolCard } from './tools/cards';
import { toolDetail, toolVerb } from './tools/config';

type Props = {
  blocks: ToolBlock[];
  /** The turn is still running. */
  live: boolean;
};

/** "Perceive project session d8344502", "Looked at 3d_iso.png". */
export function stepWords(tool: ToolBlock): string {
  const verb = toolVerb(tool);
  if (tool.name === 'Bash') return verb; // the agent's own description of the command
  const detail = toolDetail(tool);
  return detail ? `${verb} ${detail}` : verb;
}

function pictureCaption(tool: ToolBlock): string | undefined {
  const p = tool.input.file_path;
  return typeof p === 'string' ? baseName(p) : undefined;
}

function Picture({ image, caption }: { image: ToolImage; caption?: string }) {
  const [big, setBig] = useState(false);
  return (
    <figure className={big ? 'w-full' : 'max-w-full'} title={caption}>
      <button
        type="button"
        onClick={() => setBig((b) => !b)}
        title={big ? 'Smaller' : caption ? `${caption} — larger` : 'Larger'}
        className="block overflow-hidden rounded-xl border border-white/10 bg-paper shadow-[0_8px_24px_rgba(0,0,0,.35)]"
      >
        <img
          src={`data:${image.mediaType};base64,${image.data}`}
          alt={caption ?? 'picture'}
          className={big ? 'block w-full' : 'block max-h-56 w-auto'}
        />
      </button>
    </figure>
  );
}

export function Steps({ blocks, live }: Props) {
  const [open, setOpen] = useState(false);
  const current = live ? blocks.find((b) => b.result === undefined) : undefined;
  const n = blocks.length;
  const failed = blocks.filter((b) => b.isError).length;
  const label = current ? `Working · ${stepWords(current)}` : `${n} step${n === 1 ? '' : 's'}`;
  const pictures = blocks.flatMap((b) =>
    b.images.map((image, i) => ({ key: `${b.id}-${i}`, image, caption: pictureCaption(b) })),
  );

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex h-6.5 max-w-full items-center gap-1.5 rounded-full bg-panel-2/80 pr-2 pl-2 text-left text-[11.5px] font-medium text-ink-2 hover:bg-panel-3 hover:text-ink"
      >
        {current ? (
          <span className="size-2 shrink-0 rounded-full bg-accent breathe" aria-hidden />
        ) : (
          <Check className="size-3.5 shrink-0 text-sea" aria-hidden />
        )}
        <span className={`truncate ${current ? 'breathe' : ''}`}>{label}</span>
        {failed > 0 && !current && (
          <span className="shrink-0 text-[11px] text-warn">
            {failed} failed
          </span>
        )}
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        )}
      </button>
      {open && (
        <div className="rise ml-1 space-y-1.5 border-l border-line-2 pl-3">
          {blocks.map((b) => (
            <ToolCard key={b.id} tool={b} live={live} />
          ))}
        </div>
      )}
      {pictures.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {pictures.map((p) => (
            <Picture key={p.key} image={p.image} caption={p.caption} />
          ))}
        </div>
      )}
    </div>
  );
}
