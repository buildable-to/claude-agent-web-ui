import { useCallback, useEffect, useState } from 'react';
import type { ServerConfig } from '@shared/protocol';
import { ChatInput } from './components/ChatInput';
import { MessageList } from './components/MessageList';
import { PermissionBanner } from './components/PermissionBanner';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { api } from './lib/api';
import { ws, type ConnectionState } from './lib/ws';
import { useSession } from './state/useSession';
import { useSessions } from './state/useSessions';

ws.connect();

export default function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(ws.state);
  const [selected, setSelected] = useState<{ id: string | null; nonce: number }>({ id: null, nonce: 0 });
  const { sessions, refresh } = useSessions();
  const session = useSession(selected.id, selected.nonce, refresh);
  const { state } = session;

  useEffect(() => {
    api.config().then(setConfig).catch(() => setConfig(null));
    return ws.onState(setConnection);
  }, []);

  // A new session gets its id from the server; keep the sidebar in sync.
  useEffect(() => {
    if (state.sessionId && selected.id === null) void refresh();
  }, [state.sessionId, selected.id, refresh]);

  const select = useCallback((id: string | null) => {
    setSelected((s) => ({ id, nonce: s.nonce + 1 }));
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
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          projectName={projectName}
          projectDir={projectDir}
          status={state.status}
          connection={connection}
          meta={state.meta}
          onModel={session.setModel}
          onMode={session.setPermissionMode}
        />
        <MessageList
          turns={state.transcript.turns}
          status={state.status}
          loading={state.loadingHistory}
          projectName={projectName}
        />
        {pending && (
          <PermissionBanner
            request={pending}
            queued={state.pending.length - 1}
            onAnswer={session.answerPermission}
          />
        )}
        <ChatInput status={state.status} onSend={session.send} onStop={session.interrupt} autoFocus />
      </div>
    </div>
  );
}
