import { PanelRight, Plus } from 'lucide-react';
import { Menu } from './Menu';
import type { ModelOption, PermissionMode, SessionMeta, SessionStatus, SessionSummary } from '@shared/protocol';
import { money, shortPath, timeAgo } from '@/lib/format';
import { BASE } from '@/lib/page';
import { SessionControls } from './SessionControls';

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
  const locked = status === 'connecting';

  // Embedded in Project Studio the page is a panel beside the 3D: the studio's
  // own bar carries the brand, the project and the agent's state, so this row
  // is only the thread — which conversation, and a way to start another. The
  // model and mode pickers sit in the composer footer (App passes them there).
  if (picker) {
    return (
      <header className="relative flex h-11 shrink-0 items-center justify-center border-b border-white/[.06] px-12">
        <Menu
          align="center"
          wide
          head="This project's conversations"
          title="This project's conversations"
          className="text-[12.5px] text-ink"
          value={picker.activeId ?? ''}
          onPick={(v) => picker.onSelect(v || null)}
          items={[
            { value: '', label: 'New conversation', hint: 'Start fresh on this project' },
            ...picker.sessions.map((c) => ({
              value: c.sessionId,
              label: c.title,
              right: timeAgo(c.lastModified),
            })),
          ]}
        >
          {picker.activeId
            ? (picker.sessions.find((c) => c.sessionId === picker.activeId)?.title ?? 'Conversation')
            : 'New conversation'}
        </Menu>
        <span className="absolute right-2 flex items-center gap-2">
          {(connection !== 'open' || status === 'closed') && (
            <span className="font-mono text-[10.5px] text-ink-3" aria-live="polite">
              {s.text}
            </span>
          )}
          <button
            type="button"
            onClick={() => picker.onSelect(null)}
            className="iconbtn rounded-full"
            title="Start a new conversation on this project"
            aria-label="New conversation"
          >
            <Plus className="size-4" />
          </button>
        </span>
      </header>
    );
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
      <img src={`${BASE}/mark.png`} alt="" className="h-6 w-auto opacity-90" />
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
      <SessionControls meta={meta} models={models} locked={locked} look="pill" onModel={onModel} onMode={onMode} />
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
