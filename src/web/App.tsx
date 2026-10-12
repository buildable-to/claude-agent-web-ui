import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerConfig } from '@shared/protocol';
import { AgentDock } from './components/AgentDock';
import { ChatInput } from './components/ChatInput';
import { FileTree } from './components/FileTree';
import { dockLanes } from '@/lib/agents';
import { finishedFileSteps, runningAgents, stoppedWorkNotices } from '@/lib/transcript';
import { MessageList } from './components/MessageList';
import { PermissionBanner } from './components/PermissionBanner';
import { Sidebar } from './components/Sidebar';
import { WorkLine } from './components/WorkLine';
import { TopBar } from './components/TopBar';
import { api } from './lib/api';
import { armChime, chime, readChimeOn, shouldChime, shouldChimeForStoppedWork, writeChimeOn } from './lib/chime';
import { EMPTY_MENTIONS, type Mentions } from './lib/mentions';
import { listenForMentions, MentionsProvider } from './lib/mentionsLive';
import { BASE, page, tellParent } from './lib/page';
import { hearParent, readViewing, withViewing, type Viewing } from './lib/studio';
import { canShow, showViewing, ViewingProvider } from './lib/viewingLive';
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

// Embedded in Element Studio: the account's element library, no project.
const LIBRARY_COPY = {
  kicker: 'Buildable · element library',
  title: 'Build your element library',
  blurb:
    'Drop your drawing set into Drawings and ask me to make your elements. I’ll say what I found before I build anything.',
  suggestions: [
    'Make the elements from my drawings',
    'Reinforce this element to Eurocode 2',
    'Tidy this element’s drawing',
  ],
};

export default function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(ws.state);
  // "offline" only once the line has been up: the first connect at load is not an outage
  const wasOpen = useRef(false);
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
  // A step that may have written a file finished (a sub-agent's too):
  // reload the files panel now, not only when the whole turn ends.
  const fileSteps = finishedFileSteps(state.transcript);
  const agentsRunning = runningAgents(state.transcript);
  // sub-agents still out, kept under the chat where the transcript cannot
  // scroll them away
  const dock = dockLanes(state.transcript);
  // The turn ended but sub-agents or backgrounded commands are still going:
  // to the engineer (the work line, the tab, Project Studio's bar) the agent
  // is still working.
  // the engine's own list only: a task the transcript still marks running
  // (a missed notification) must not keep the page "working" for ever
  const background = state.status === 'idle' && state.background.length > 0;
  const shownStatus = background ? 'running' : state.status;
  useEffect(() => {
    if (fileSteps > 0) setTreeKey((k) => k + 1);
  }, [fileSteps]);
  const { commands, models, loading: commandsLoading } = useEngineInfo(state.meta);
  const autoPicked = useRef(false);
  // the project's marks and elements for "@", posted in by the studio
  const [mentions, setMentions] = useState<Mentions>(EMPTY_MENTIONS);
  useEffect(() => (embed ? listenForMentions(setMentions) : undefined), []);
  // What is on the studio's screen, posted in whenever it changes. It rides
  // in front of the next message as a "Looking at …" line, always on; the ✕
  // on the chip drops it until the screen changes again (`viewingOff` holds
  // the text that was dismissed, so the next different screen shows anew).
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const [viewingOff, setViewingOff] = useState<string | null>(null);
  useEffect(() => {
    if (!embed) return undefined;
    return hearParent((m) => {
      const v = readViewing(m);
      if (v) setViewing(v);
    });
  }, []);
  const viewingOn = viewing && viewing.text !== viewingOff ? viewing : null;

  // Embedded on a project: open the conversation the link names, else the
  // latest one, so the engineer continues where they left off instead of
  // starting blank every time.
  useEffect(() => {
    if (!embed || autoPicked.current || !sessionsLoaded) return;
    autoPicked.current = true; // decided once, on the first list; "New" later means new
    if (selected.id !== null || state.transcript.turns.length > 0 || state.status !== 'idle') return;
    const named = page.conversation ? sessions.find((x) => x.sessionId === page.conversation) : undefined;
    // an element's page: the chat its address names (a draft's chat that
    // followed it into the element, not yet in this element's list) opens;
    // else this element's own latest; else a new one (ezdxf-flask #723)
    if (page.subject && page.conversation && !named) {
      setSelected((s) => ({ id: page.conversation, nonce: s.nonce + 1 }));
      return;
    }
    if (page.subject) {
      const own = sessions[0];
      if (own) setSelected((s) => ({ id: own.sessionId, nonce: s.nonce + 1 }));
      return;
    }
    // the library lists only its own chats: a link naming any other one
    // (a project's) opens a new library chat, not the latest
    if (page.scope === 'library' && page.conversation && !named) return;
    // one element's page starts its own chat; the others are in the list
    if (page.fresh && !named) return;
    const open = named ?? sessions[0];
    if (open) setSelected((s) => ({ id: open.sessionId, nonce: s.nonce + 1 }));
  }, [sessionsLoaded, sessions, selected.id, state.transcript.turns.length, state.status]);

  // The page that embeds us keeps the open conversation in its address, so a
  // link lands on this exact conversation and Back/Forward walk between them.
  // A new conversation has no id until its first turn; it is told then.
  const openConversation = selected.id ?? state.sessionId ?? null;

  // an element's page owns the conversation open on it: a new chat begun
  // here, or a draft's chat that followed it into the element, is about this
  // element from now on — its list shows it, other elements' do not
  const subjected = useRef(new Set<string>());
  useEffect(() => {
    const id = openConversation;
    if (!page.subject || !id || subjected.current.has(id)) return;
    const row = sessions.find((x) => x.sessionId === id);
    if (row && row.subject === page.subject) {
      subjected.current.add(id);
      return;
    }
    if (!row && !state.sessionId) return;            // not started yet: no id to tag
    subjected.current.add(id);
    void api.setSubject(id, page.subject).then(() => refresh()).catch(() => subjected.current.delete(id));
  }, [openConversation, sessions, state.sessionId, refresh]);
  useEffect(() => {
    if (!embed) return;
    tellParent({ type: 'conversation', id: openConversation });
  }, [openConversation]);

  // The page that embeds us wants two things: when the project changed for
  // real (redraw), and whether the agent needs a human (badge the fold button).
  useEffect(() => {
    return ws.subscribe((m) => {
      if (m.type === 'project_changed') {
        tellParent({ type: 'project_changed', sessionId: m.sessionId, ...(m.project ? { project: m.project } : {}) });
      } else if (m.type === 'element_focus') {
        // what the agent read or saved: the same highlight note a pill sends,
        // carrying an id instead of a mark — and `auto`, because nobody
        // clicked: the Elements tab adds a row and counts it, it does not
        // jump (ezdxf-flask #469)
        tellParent({ type: 'highlight', auto: true, ...(m.kind === 'draft' ? { draft_id: m.id } : { element_id: m.id }) });
      }
    });
  }, []);
  useEffect(() => {
    // the line to the server is down: whatever the agent is doing, this page
    // cannot know — the studio must not keep saying "working" on its word
    // (while it retries it flips closed ↔ connecting: both are offline, or
    // the studio's bar flickers and refetches on every retry). Expired has
    // its own message and word on the bar.
    if (connection === 'expired') return;
    if (connection === 'open') wasOpen.current = true;
    tellParent({ type: 'status', status: connection === 'open' || !wasOpen.current ? shownStatus : 'offline' });
  }, [shownStatus, connection]);
  useEffect(() => {
    if (connection === 'expired') tellParent({ type: 'expired' });
  }, [connection]);

  // A card came up while the engineer's eyes were on the model: a chime,
  // unless this browser turned it off. The bell under the composer is the
  // switch; turning it on plays the chime once, so they hear what it is —
  // and that click is the gesture the browser wants before it lets the page
  // sound.
  const [chimeOn, setChimeOn] = useState(readChimeOn);
  const lastStatus = useRef(state.status);
  useEffect(() => {
    armChime();
  }, []);
  useEffect(() => {
    const prev = lastStatus.current;
    lastStatus.current = state.status;
    if (chimeOn && shouldChime(prev, state.status)) chime();
  }, [state.status, chimeOn]);
  useEffect(() => {
    if (shouldChimeForStoppedWork(stoppedWorkNotices(state.transcript), chimeOn)) chime();
  }, [state.transcript, chimeOn]);
  const toggleChime = useCallback(() => {
    const next = !chimeOn;
    writeChimeOn(next);
    setChimeOn(next);
    if (next) chime();
  }, [chimeOn]);

  // The tab itself reports state: a dot on the icon and a title prefix.
  useEffect(() => {
    const name = config?.projectName ?? 'Claude Agent Web UI';
    const attention = state.status === 'requires_action';
    // offline, this page no longer knows: the tab must not say working
    const working = connection === 'open' && (shownStatus === 'running' || state.status === 'starting');
    document.title = attention ? `● Needs you · ${name}` : working ? `… Working · ${name}` : name;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) {
      link.href = `${BASE}/${attention ? 'favicon-attention.png' : working ? 'favicon-working.png' : 'favicon.png'}`;
    }
  }, [state.status, shownStatus, connection, config?.projectName]);

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
    <MentionsProvider value={mentions}>
    <ViewingProvider value={viewing}>
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
          agentsRunning={agentsRunning}
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
          {...(embed ? (page.scope === 'library' ? LIBRARY_COPY : EMBED_COPY) : {})}
        />
        {dock.length > 0 && <AgentDock lanes={dock} />}
        <WorkLine
          connection={connection}
          status={state.status}
          background={background ? state.background : null}
          since={state.busySince}
          transcript={state.transcript}
        />
        {connection === 'expired' && (
          <p className="mx-auto w-full max-w-3xl px-6 text-[12.5px] text-warn">
            This page’s access has expired. Reload the {page.scope === 'library' ? 'page' : 'project'} to continue.
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
          onSend={(text) => {
            // the page that embeds us keeps the first thing the engineer says
            // on an empty project as its brief (Buildable issue #405) — the
            // brief is what the ENGINEER wrote, so the looking-at line stays
            // out of it and goes only to the engine, in front of the words
            tellParent({ type: 'user_message', text });
            session.send(withViewing(text, viewingOn));
          }}
          onStop={session.interrupt}
          backgroundWork={background}
          connected={connection === 'open'}
          commands={commands}
          commandsLoading={commandsLoading}
          autoFocus
          focusKey={focusKey}
          mentions={mentions}
          viewing={viewingOn}
          onDismissViewing={() => setViewingOff(viewing ? viewing.text : null)}
          viewingDismissed={!!viewing && !viewingOn}
          onRestoreViewing={() => setViewingOff(null)}
          onShowViewing={canShow(viewingOn) ? () => showViewing(viewingOn) : undefined}
          chime={chimeOn}
          onChime={toggleChime}
          {...(embed
            ? {
                controls: {
                  meta: state.meta,
                  models,
                  locked: state.status === 'connecting',
                  onModel: session.setModel,
                  onMode: session.setPermissionMode,
                },
              }
            : {})}
        />
      </div>
      {filesOpen && !embed && <FileTree onPick={(p) => insertText(p)} refreshKey={treeKey} />}
    </div>
    </ViewingProvider>
    </MentionsProvider>
  );
}
