import type { PermissionMode, SessionMeta, SessionStatus } from '@shared/protocol';
import { money, shortPath } from '@/lib/format';

type Props = {
  projectName: string;
  projectDir: string;
  status: SessionStatus | 'connecting';
  connection: 'connecting' | 'open' | 'closed';
  meta: SessionMeta;
  onModel: (model: string | null) => void;
  onMode: (mode: PermissionMode) => void;
};

const MODES: Array<{ value: PermissionMode; label: string; hint: string }> = [
  { value: 'default', label: 'Ask first', hint: 'Prompts before edits and commands, like the terminal.' },
  { value: 'acceptEdits', label: 'Auto-accept edits', hint: 'File edits go through without asking; commands still ask.' },
  { value: 'plan', label: 'Plan only', hint: 'Read-only. Claude plans but does not change anything.' },
  { value: 'auto', label: 'Auto (classifier)', hint: 'A model decides what to allow.' },
  { value: 'bypassPermissions', label: 'Bypass all', hint: 'Never asks. Only for throwaway work.' },
];

function statusLabel(status: Props['status'], connection: Props['connection']) {
  if (connection !== 'open') return { text: connection === 'closed' ? 'Reconnecting…' : 'Connecting…', tone: 'bg-ink-3' };
  switch (status) {
    case 'connecting':
    case 'starting':
      return { text: 'Starting engine…', tone: 'bg-ink-3 animate-pulse' };
    case 'idle':
      return { text: 'Ready', tone: 'bg-ok' };
    case 'running':
      return { text: 'Working', tone: 'bg-accent animate-pulse' };
    case 'requires_action':
      return { text: 'Needs your approval', tone: 'bg-warn animate-pulse' };
    case 'closed':
      return { text: 'Stopped', tone: 'bg-ink-3' };
  }
}

export function TopBar({ projectName, projectDir, status, connection, meta, onModel, onMode }: Props) {
  const s = statusLabel(status, connection);
  const models = meta.models ?? [];
  const modelValue = meta.model ?? '';
  const modelKnown = models.some((m) => m.value === modelValue);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-semibold text-ink">{projectName}</div>
        <div className="truncate font-mono text-[11px] text-ink-3" title={projectDir}>
          {shortPath(projectDir, 60)}
        </div>
      </div>
      <div className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
        <span className={`size-2 rounded-full ${s.tone}`} />
        {s.text}
      </div>
      {meta.totalCostUsd !== undefined && (
        <span className="font-mono text-[11.5px] text-ink-3" title="Estimated cost this session">
          {money(meta.totalCostUsd)}
        </span>
      )}
      <select
        value={modelKnown ? modelValue : ''}
        onChange={(e) => onModel(e.target.value || null)}
        disabled={status === 'closed' || status === 'connecting'}
        title="Model"
        className="rounded-md border border-line bg-surface px-2 py-1 text-[12.5px] text-ink"
      >
        {!modelKnown && <option value="">{modelValue || 'Default model'}</option>}
        {models.map((m) => (
          <option key={m.value} value={m.value} title={m.description}>
            {m.label}
          </option>
        ))}
      </select>
      <select
        value={meta.permissionMode ?? 'default'}
        onChange={(e) => onMode(e.target.value as PermissionMode)}
        disabled={status === 'closed' || status === 'connecting'}
        title={MODES.find((m) => m.value === meta.permissionMode)?.hint ?? 'Permission mode'}
        className="rounded-md border border-line bg-surface px-2 py-1 text-[12.5px] text-ink"
      >
        {MODES.map((m) => (
          <option key={m.value} value={m.value} title={m.hint}>
            {m.label}
          </option>
        ))}
      </select>
    </header>
  );
}
