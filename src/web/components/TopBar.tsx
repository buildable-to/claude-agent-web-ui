import { PanelRight } from 'lucide-react';
import type { ModelOption, PermissionMode, SessionMeta, SessionStatus } from '@shared/protocol';
import { money, shortPath } from '@/lib/format';

type Props = {
  projectName: string;
  projectDir: string;
  status: SessionStatus | 'connecting';
  connection: 'connecting' | 'open' | 'closed';
  meta: SessionMeta;
  models: ModelOption[];
  filesOpen: boolean;
  onToggleFiles: () => void;
  onModel: (model: string | null) => void;
  onMode: (mode: PermissionMode) => void;
};

const MODES: Array<{ value: PermissionMode; label: string; hint: string }> = [
  { value: 'default', label: 'Ask first', hint: 'Asks before edits and commands, like the terminal.' },
  { value: 'acceptEdits', label: 'Auto-accept edits', hint: 'File edits go through; commands still ask.' },
  { value: 'plan', label: 'Plan only', hint: 'Read-only. Claude plans but changes nothing.' },
  { value: 'auto', label: 'Auto', hint: 'A classifier decides what to allow.' },
  { value: 'bypassPermissions', label: 'Bypass all', hint: 'Never asks. Throwaway work only.' },
];

function statusLabel(status: Props['status'], connection: Props['connection']) {
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
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
      <img src="/mark.png" alt="" className="h-6 w-auto opacity-90" />
      <div className="min-w-0 flex-1">
        <div className="font-display truncate text-[14px] font-semibold tracking-tight text-ink">{projectName}</div>
        <div className="truncate font-mono text-[10.5px] text-ink-3" title={projectDir}>
          {shortPath(projectDir, 64)}
        </div>
      </div>
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
            {m.label}
          </option>
        ))}
      </select>
      <select
        className="pill"
        value={meta.permissionMode ?? 'default'}
        onChange={(e) => onMode(e.target.value as PermissionMode)}
        disabled={locked}
        title={MODES.find((m) => m.value === meta.permissionMode)?.hint ?? 'Permission mode'}
      >
        {MODES.map((m) => (
          <option key={m.value} value={m.value} title={m.hint}>
            {m.label}
          </option>
        ))}
      </select>
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
    </header>
  );
}
