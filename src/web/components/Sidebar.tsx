import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { SessionSummary } from '@shared/protocol';
import { timeAgo } from '@/lib/format';

type Props = {
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
};

export function Sidebar({ sessions, activeId, onSelect, onNew, onRename, onDelete }: Props) {
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex h-12 items-center justify-between border-b border-line px-3">
        <span className="text-[11px] font-medium tracking-wider text-ink-3 uppercase">Sessions</span>
        <button
          type="button"
          onClick={onNew}
          className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[12px] font-medium text-white hover:opacity-90"
        >
          <Plus className="size-3.5" /> New
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {sessions.length === 0 && (
          <p className="px-3 py-4 text-[12.5px] text-ink-3">No sessions in this project yet.</p>
        )}
        {sessions.map((s) => {
          const active = s.sessionId === activeId;
          const isEditing = editing?.id === s.sessionId;
          const isConfirming = confirming === s.sessionId;
          return (
            <div
              key={s.sessionId}
              className={`group relative mx-1.5 my-0.5 rounded-md ${active ? 'bg-accent-soft' : 'hover:bg-surface-2'}`}
            >
              {isEditing ? (
                <form
                  className="flex items-center gap-1 px-2 py-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (editing.title.trim()) onRename(s.sessionId, editing.title.trim());
                    setEditing(null);
                  }}
                >
                  <input
                    autoFocus
                    value={editing.title}
                    onChange={(e) => setEditing({ id: s.sessionId, title: e.target.value })}
                    onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}
                    className="min-w-0 flex-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[12.5px] text-ink outline-none focus:border-accent"
                  />
                  <button type="submit" className="text-ok" title="Save">
                    <Check className="size-3.5" />
                  </button>
                  <button type="button" onClick={() => setEditing(null)} className="text-ink-3" title="Cancel">
                    <X className="size-3.5" />
                  </button>
                </form>
              ) : isConfirming ? (
                <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[12.5px]">
                  <span className="text-ink">Delete this session?</span>
                  <span className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onDelete(s.sessionId);
                        setConfirming(null);
                      }}
                      className="font-medium text-danger"
                    >
                      Delete
                    </button>
                    <button type="button" onClick={() => setConfirming(null)} className="text-ink-2">
                      Keep
                    </button>
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => onSelect(s.sessionId)}
                  className="block w-full px-2.5 py-1.5 text-left"
                >
                  <div className="flex items-start gap-1.5">
                    {s.live && (
                      <span
                        className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                          s.status === 'running' || s.status === 'requires_action'
                            ? 'animate-pulse bg-accent'
                            : 'bg-ok'
                        }`}
                        title={s.status === 'requires_action' ? 'Needs approval' : s.status ?? 'live'}
                      />
                    )}
                    <span className="line-clamp-2 text-[12.5px] leading-snug text-ink">{s.title}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-3">
                    <span>{timeAgo(s.lastModified)}</span>
                    {s.gitBranch && s.gitBranch !== 'HEAD' && (
                      <span className="truncate font-mono">· {s.gitBranch}</span>
                    )}
                  </div>
                </button>
              )}
              {!isEditing && !isConfirming && (
                <div className="absolute top-1 right-1 hidden gap-0.5 group-hover:flex">
                  <button
                    type="button"
                    onClick={() => setEditing({ id: s.sessionId, title: s.title })}
                    className="rounded p-1 text-ink-3 hover:bg-surface hover:text-ink"
                    title="Rename"
                  >
                    <Pencil className="size-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(s.sessionId)}
                    className="rounded p-1 text-ink-3 hover:bg-surface hover:text-danger"
                    title="Delete"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
