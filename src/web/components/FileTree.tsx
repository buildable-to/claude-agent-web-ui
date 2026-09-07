import { ChevronRight, File, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirectoryTree, TreeNode } from '@shared/protocol';
import { api } from '@/lib/api';

type Props = {
  /** Called with the relative path when a file is clicked. */
  onPick: (path: string) => void;
  /** Bump to reload the listing, e.g. after Claude finishes a turn. */
  refreshKey?: number;
};

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toUpperCase() : '';
}

/** Every file path under a node. */
function paths(node: TreeNode, out: Set<string> = new Set()): Set<string> {
  if (node.type === 'file') out.add(node.path);
  node.children?.forEach((c) => paths(c, out));
  return out;
}

function holdsFresh(node: TreeNode, fresh: Set<string>): boolean {
  if (node.type === 'file') return fresh.has(node.path);
  return Boolean(node.children?.some((c) => holdsFresh(c, fresh)));
}

type NodeProps = { node: TreeNode; depth: number; onPick: (p: string) => void; fresh: Set<string> };

function Node({ node, depth, onPick, fresh }: NodeProps) {
  const isDir = node.type === 'dir';
  const isFresh = isDir ? holdsFresh(node, fresh) : fresh.has(node.path);
  const [open, setOpen] = useState(false);
  // A folder that just gained a file opens by itself: the file the agent
  // wrote is what the engineer is looking for.
  useEffect(() => {
    if (isDir && isFresh) setOpen(true);
  }, [isDir, isFresh]);
  const Icon = isDir ? (open ? FolderOpen : Folder) : File;
  return (
    <div>
      <button
        type="button"
        onClick={() => (isDir ? setOpen((o) => !o) : onPick(node.path))}
        className="group flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left text-[12px] text-ink-2 hover:bg-panel-2 hover:text-ink"
        style={{ paddingLeft: 8 + depth * 14 }}
        title={isDir ? node.path || node.name : `Add ${node.path} to your message`}
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center text-ink-3">
          {isDir ? <ChevronRight className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} /> : null}
        </span>
        <Icon className={`size-3.5 shrink-0 ${isDir ? 'text-sea' : 'text-accent'}`} />
        <span className={`min-w-0 flex-1 truncate ${isFresh && !isDir ? 'text-ink' : ''}`}>{node.name}</span>
        {isFresh && !isDir && (
          <span className="size-1.5 shrink-0 rounded-full bg-accent" title="New since the last listing" aria-label="new" />
        )}
        {!isDir && ext(node.name) && (
          <span className="rounded border border-line px-1 text-[9px] tracking-wide text-ink-3">{ext(node.name)}</span>
        )}
      </button>
      {isDir &&
        open &&
        node.children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} onPick={onPick} fresh={fresh} />)}
    </div>
  );
}

export function FileTree({ onPick, refreshKey = 0 }: Props) {
  const [tree, setTree] = useState<DirectoryTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Files that appeared since the previous listing; none on the first. */
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const known = useRef<Set<string> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.tree();
      const now = paths(next.tree);
      const before = known.current;
      known.current = now;
      if (before) {
        const added = new Set([...now].filter((p) => !before.has(p)));
        if (added.size) setFresh((f) => new Set([...f, ...added]));
      }
      setTree(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-l border-line bg-sidebar">
      <div className="flex h-14 items-center justify-between border-b border-line px-4">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold tracking-[0.18em] text-ink-3 uppercase">Project files</div>
          {tree && (
            <div className="mt-0.5 text-[11.5px] text-ink-3">
              {tree.files} files · {tree.dirs} folders{tree.truncated ? ' · trimmed' : ''}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="pill px-2.5"
          title="Refresh"
          disabled={loading}
        >
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {error && <p className="px-2 text-[12.5px] text-danger">{error}</p>}
        {!error && !tree && <p className="px-2 text-[12.5px] text-ink-3">Reading the folder…</p>}
        {tree?.tree.children?.map((c) => <Node key={c.path} node={c} depth={0} onPick={onPick} fresh={fresh} />)}
        {tree && tree.tree.children?.length === 0 && (
          <p className="px-2 text-[12.5px] text-ink-3">This folder is empty.</p>
        )}
      </div>
      <p className="border-t border-line px-4 py-2 text-[11px] text-ink-3">Click a file to mention it.</p>
    </aside>
  );
}
