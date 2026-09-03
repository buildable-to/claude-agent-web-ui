import { useCallback, useEffect, useState } from 'react';
import type { ServerConfig } from '@shared/protocol';
import { ChatInput } from './components/ChatInput';
import { FileTree } from './components/FileTree';
import { MessageList } from './components/MessageList';
import { PermissionBanner } from './components/PermissionBanner';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { api } from './lib/api';
import { ws, type ConnectionState } from './lib/ws';
import { useSession } from './state/useSession';
import { useSessions } from './state/useSessions';

ws.connect();

function readFilesOpen(): boolean {
  try {
    return localStorage.getItem('filesOpen') !== '0';
  } catch {
    return true;
  }
}

export default function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(ws.state);
  const [selected, setSelected] = useState<{ id: string | null; nonce: number }>({ id: null, nonce: 0 });
  const [draft, setDraft] = useState('');
  const [focusKey, setFocusKey] = useState(0);
  const [filesOpen, setFilesOpen] = useState(readFilesOpen);
  const [treeKey, setTreeKey] = useState(0);
  const { sessions, refresh } = useSessions();
  const onTurnEnd = useCallback(() => {
    void refresh();
    setTreeKey((k) => k + 1);
  }, [refresh]);
  const session = useSession(selected.id, selected.nonce, onTurnEnd);
  const { state } = session;

  // The tab itself reports state: a dot on the icon and a title prefix.
  useEffect(() => {
    const name = config?.projectName ?? 'Claude Agent Web UI';
    const attention = state.status === 'requires_action';
    const working = state.status === 'running' || state.status === 'starting';
    document.title = attention ? `● Needs you · ${name}` : working ? `… Working · ${name}` : name;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) {
      link.href = attention ? '/favicon-attention.png' : working ? '/favicon-working.png' : '/favicon.png';
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
      <Sidebar
        sessions={sessions}
        activeId={state.sessionId}
        onSelect={select}
        onNew={() => select(null)}
        onRename={rename}
        onDelete={remove}
      />
      <div className="glass flex min-w-0 flex-1 flex-col">
        <TopBar
          projectName={projectName}
          projectDir={projectDir}
          status={state.status}
          connection={connection}
          meta={state.meta}
          filesOpen={filesOpen}
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
        />
        {pending && (
          <PermissionBanner
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
          autoFocus
          focusKey={focusKey}
        />
      </div>
      {filesOpen && <FileTree onPick={(p) => insertText(p)} refreshKey={treeKey} />}
    </div>
  );
}
