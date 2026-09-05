import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerConfig } from '@shared/protocol';
import { ChatInput } from './components/ChatInput';
import { FileTree } from './components/FileTree';
import { MessageList } from './components/MessageList';
import { PermissionBanner } from './components/PermissionBanner';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { api } from './lib/api';
import { BASE, page, tellParent } from './lib/page';
import { ws, type ConnectionState } from './lib/ws';
import { useEngineInfo } from './state/useEngineInfo';
import { useSession } from './state/useSession';
import { useSessions } from './state/useSessions';

ws.connect();

const embed = page.embed;

function readFilesOpen(): boolean {
  if (embed) return false;
  try {
    return localStorage.getItem('filesOpen') !== '0';
  } catch {
    return true;
  }
}

// Embedded in Project Studio the page speaks to a precast engineer about one
// project, not to a developer about a code base.
const EMBED_COPY = {
  kicker: 'Buildable · this project',
  blurb:
    'Describe what to build or change. The agent works through Buildable’s own doors and stops to ask you before it changes the project for real.',
  suggestions: [
    'Add four columns on pads at a 6 m grid, beams on top',
    'Check this project and list what is wrong',
    'Reinforce beam B1 to Eurocode 2',
  ],
};

export default function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(ws.state);
  const [selected, setSelected] = useState<{ id: string | null; nonce: number }>({ id: null, nonce: 0 });
  const [draft, setDraft] = useState('');
  const [focusKey, setFocusKey] = useState(0);
  const [filesOpen, setFilesOpen] = useState(readFilesOpen);
  const [treeKey, setTreeKey] = useState(0);
  const { sessions, loaded: sessionsLoaded, refresh } = useSessions();
  const onTurnEnd = useCallback(() => {
    void refresh();
    setTreeKey((k) => k + 1);
  }, [refresh]);
  const session = useSession(selected.id, selected.nonce, onTurnEnd);
  const { state } = session;
  const { commands, models, loading: commandsLoading } = useEngineInfo(state.meta);
  const autoPicked = useRef(false);

  // Embedded on a project: open its latest conversation, so the engineer
  // continues where they left off instead of starting blank every time.
  useEffect(() => {
    if (!embed || autoPicked.current || !sessionsLoaded) return;
    autoPicked.current = true; // decided once, on the first list; "New" later means new
    if (selected.id !== null || state.transcript.turns.length > 0 || state.status !== 'idle') return;
    const latest = sessions[0];
    if (latest) setSelected((s) => ({ id: latest.sessionId, nonce: s.nonce + 1 }));
  }, [sessionsLoaded, sessions, selected.id, state.transcript.turns.length, state.status]);

  // The page that embeds us wants two things: when the project changed for
  // real (redraw), and whether the agent needs a human (badge the fold button).
  useEffect(() => {
    return ws.subscribe((m) => {
      if (m.type === 'project_changed') {
        tellParent({ type: 'project_changed', sessionId: m.sessionId, ...(m.project ? { project: m.project } : {}) });
      }
    });
  }, []);
  useEffect(() => {
    tellParent({ type: 'status', status: state.status });
  }, [state.status]);
  useEffect(() => {
    if (connection === 'expired') tellParent({ type: 'expired' });
  }, [connection]);

  // The tab itself reports state: a dot on the icon and a title prefix.
  useEffect(() => {
    const name = config?.projectName ?? 'Claude Agent Web UI';
    const attention = state.status === 'requires_action';
    const working = state.status === 'running' || state.status === 'starting';
    document.title = attention ? `● Needs you · ${name}` : working ? `… Working · ${name}` : name;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) {
      link.href = `${BASE}/${attention ? 'favicon-attention.png' : working ? 'favicon-working.png' : 'favicon.png'}`;
    }
  }, [state.status, config?.projectName]);

  useEffect(() => {
    api.config().then(setConfig).catch(() => setConfig(null));
    const off = ws.onState(setConnection);
    setConnection(ws.state);
    return off;
  }, []);

  useEffect(() => {
    if (state.sessionId && selected.id === null) void refresh();
  }, [state.sessionId, selected.id, refresh]);

  const select = useCallback((id: string | null) => {
    setSelected((s) => ({ id, nonce: s.nonce + 1 }));
    setFocusKey((k) => k + 1);
  }, []);

  const rename = useCallback(
    async (id: string, title: string) => {
      await api.rename(id, title).catch(() => undefined);
      void refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await api.remove(id).catch(() => undefined);
      if (state.sessionId === id) select(null);
      void refresh();
    },
    [refresh, select, state.sessionId],
  );

  const toggleFiles = useCallback(() => {
    setFilesOpen((o) => {
      try {
        localStorage.setItem('filesOpen', o ? '0' : '1');
      } catch {
        // ignore
      }
      return !o;
    });
  }, []);

  const insertText = useCallback((text: string) => {
    setDraft((d) => (d && !d.endsWith(' ') ? `${d} ${text}` : `${d}${text}`));
    setFocusKey((k) => k + 1);
  }, []);

  const projectName = config?.projectName ?? '…';
  const projectDir = config?.projectDir ?? '';
  const pending = state.pending[0];

  return (
    <div className="flex h-full">
      {!embed && (
        <Sidebar
          sessions={sessions}
          activeId={state.sessionId}
          onSelect={select}
          onNew={() => select(null)}
          onRename={rename}
          onDelete={remove}
        />
      )}
      <div className="glass flex min-w-0 flex-1 flex-col">
        <TopBar
          projectName={projectName}
          projectDir={projectDir}
          status={state.status}
          connection={connection}
          meta={state.meta}
          models={models}
          filesOpen={filesOpen}
          hideFiles={embed}
          {...(embed ? { picker: { sessions, activeId: state.sessionId, onSelect: select } } : {})}
          onToggleFiles={toggleFiles}
          onModel={session.setModel}
          onMode={session.setPermissionMode}
        />
        <MessageList
          turns={state.transcript.turns}
          status={state.status}
          loading={state.loadingHistory}
          projectName={projectName}
          onSuggest={(text) => {
            setDraft(text);
            setFocusKey((k) => k + 1);
          }}
          {...(embed ? EMBED_COPY : {})}
        />
        {connection === 'expired' && (
          <p className="mx-auto w-full max-w-3xl px-6 text-[12.5px] text-warn">
            This page’s access has expired. Reload the project to continue.
          </p>
        )}
        {pending && (
          <PermissionBanner
            key={pending.requestId}
            request={pending}
            queued={state.pending.length - 1}
            onAnswer={session.answerPermission}
          />
        )}
        <ChatInput
          value={draft}
          onChange={setDraft}
          status={state.status}
          onSend={session.send}
          onStop={session.interrupt}
          commands={commands}
          commandsLoading={commandsLoading}
          autoFocus
          focusKey={focusKey}
        />
      </div>
      {filesOpen && !embed && <FileTree onPick={(p) => insertText(p)} refreshKey={treeKey} />}
    </div>
  );
}
