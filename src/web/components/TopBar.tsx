import { PanelRight, Plus } from 'lucide-react';
import type { ModelOption, PermissionMode, SessionMeta, SessionStatus, SessionSummary } from '@shared/protocol';
import { money, shortPath, timeAgo } from '@/lib/format';
import { BASE } from '@/lib/page';

type Props = {
  projectName: string;
  projectDir: string;
  status: SessionStatus | 'connecting';
  connection: 'connecting' | 'open' | 'closed' | 'expired';
  meta: SessionMeta;
  models: ModelOption[];
  filesOpen: boolean;
  /** Hide the files toggle (embedded in Project Studio there is nothing to browse). */
  hideFiles?: boolean;
  /** Embedded: the conversations of this project as a picker instead of the sidebar. */
  picker?: {
    sessions: SessionSummary[];
    activeId: string | null;
    onSelect: (id: string | null) => void;
  };
  onToggleFiles: () => void;
  onModel: (model: string | null) => void;
  onMode: (mode: PermissionMode) => void;
};

const MODES: Array<{ value: PermissionMode; label: string; hint: string }> = [
  { value: 'default', label: 'Ask first', hint: 'Asks before edits and commands, like the terminal.' },
  { value: 'acceptEdits', label: 'Auto-accept edits', hint: 'Scratch files go through; every command still asks (the live apply, the memory write).' },
  { value: 'plan', label: 'Plan only', hint: 'Read-only. Claude plans but changes nothing.' },
  { value: 'auto', label: 'Auto', hint: 'A classifier decides what to allow.' },
  // No "Bypass all": on a shared server that would switch the gates off for
  // everyone who can reach the page. The terminal keeps it for throwaway work.
];

/** "Default (recommended)" says nothing about which model runs; name it:
 *  "Default · Opus 5 with 1M context" (the engine's own description, first part). */
function modelLabel(m: ModelOption): string {
  if (m.value !== 'default' || !m.description) return m.label;
  const what = m.description.split(' · ')[0]?.trim();
  return what ? `Default · ${what}` : m.label;
}

function statusLabel(status: Props['status'], connection: Props['connection']) {
  if (connection === 'expired') return { text: 'Expired · reload', dot: 'bg-warn' };
  if (connection !== 'open') {
    return { text: connection === 'closed' ? 'Reconnecting' : 'Connecting', dot: 'bg-ink-3 breathe' };
  }
  switch (status) {
    case 'connecting':
    case 'starting':
      return { text: 'Starting', dot: 'bg-ink-3 breathe' };
    case 'idle':
      return { text: 'Ready', dot: 'bg-sea' };
    case 'running':
      return { text: 'Working', dot: 'bg-accent breathe' };
    case 'requires_action':
      return { text: 'Needs you', dot: 'bg-warn breathe' };
    case 'closed':
      return { text: 'Stopped', dot: 'bg-ink-3' };
  }
}

export function TopBar({
  projectName,
  projectDir,
  status,
  connection,
  meta,
  models,
  filesOpen,
  hideFiles = false,
  picker,
  onToggleFiles,
  onModel,
  onMode,
}: Props) {
  const s = statusLabel(status, connection);
  const current = meta.model ?? '';
  // The engine reports a resolved id; the menu lists aliases. Match either.
  const match =
    models.find((m) => m.value === current || m.resolved === current) ??
    (current ? undefined : (models.find((m) => m.value === 'default') ?? models[0]));
  const modelValue = match?.value ?? '';
  const locked = status === 'connecting';

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
      <img src={`${BASE}/mark.png`} alt="" className="h-6 w-auto opacity-90" />
      {picker ? (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <select
            className="pill min-w-0 max-w-[60%] flex-1 truncate"
            value={picker.activeId ?? ''}
            onChange={(e) => picker.onSelect(e.target.value || null)}
            title="This project's conversations"
          >
            <option value="">New conversation</option>
            {picker.sessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.title.length > 48 ? `${s.title.slice(0, 47)}…` : s.title} · {timeAgo(s.lastModified)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => picker.onSelect(null)}
            className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-[12px] font-semibold text-white transition hover:bg-accent-dim active:translate-y-px"
            title="Start a new conversation on this project"
          >
            <Plus className="size-3.5" /> New
          </button>
        </div>
      ) : (
        <div className="min-w-0 flex-1">
          <div className="font-display truncate text-[14px] font-semibold tracking-tight text-ink">{projectName}</div>
          <div className="truncate font-mono text-[10.5px] text-ink-3" title={projectDir}>
            {shortPath(projectDir, 64)}
          </div>
        </div>
      )}
      <span className="pill" aria-live="polite">
        <span className={`size-2 rounded-full ${s.dot}`} />
        {s.text}
      </span>
      {meta.totalCostUsd !== undefined && (
        <span className="font-mono text-[11.5px] text-ink-3" title="Estimated cost this session">
          {money(meta.totalCostUsd)}
        </span>
      )}
      <select
        className="pill"
        value={modelValue}
        onChange={(e) => onModel(e.target.value || null)}
        disabled={locked}
        title="Model"
      >
        {!match && <option value="">{current || 'Default model'}</option>}
        {models.map((m) => (
          <option key={m.value} value={m.value} title={m.description}>
            {modelLabel(m)}
          </option>
        ))}
      </select>
      <select
        className="pill"
        value={meta.permissionMode ?? (picker ? 'acceptEdits' : 'default')}
        onChange={(e) => onMode(e.target.value as PermissionMode)}
        disabled={locked}
        title={MODES.find((m) => m.value === meta.permissionMode)?.hint ?? 'Permission mode'}
      >
        {/* Embedded for engineers: the modes where every command still asks; "Auto" would let a classifier wave a live apply through. */}
        {MODES.filter((m) => !picker || m.value !== 'auto').map((m) => (
          <option key={m.value} value={m.value} title={m.hint}>
            {m.label}
          </option>
        ))}
      </select>
      {!hideFiles && (
        <button
          type="button"
          onClick={onToggleFiles}
          className={`pill ${filesOpen ? 'bg-accent-soft' : ''}`}
          title={filesOpen ? 'Hide project files' : 'Show project files'}
          aria-pressed={filesOpen}
        >
          <PanelRight className="size-3.5" />
          Files
        </button>
      )}
    </header>
  );
}
