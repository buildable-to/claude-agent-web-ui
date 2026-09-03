import { useCallback, useEffect, useReducer, useRef } from 'react';
import type {
  PermissionMode,
  PermissionRequest,
  ServerMessage,
  SessionMeta,
  SessionStatus,
} from '@shared/protocol';
import { api } from '@/lib/api';
import {
  addLocalUserTurn,
  addNote,
  applyHistory,
  applyMessage,
  emptyTranscript,
  type Transcript,
} from '@/lib/transcript';
import { ws } from '@/lib/ws';

export type SessionState = {
  /** Id once the server has attached; null while a new session is starting. */
  sessionId: string | null;
  cwd: string | null;
  status: SessionStatus | 'connecting';
  meta: SessionMeta;
  transcript: Transcript;
  pending: PermissionRequest[];
  loadingHistory: boolean;
  error: string | null;
};

type Action =
  | { type: 'reset'; sessionId: string | null }
  | { type: 'history'; transcript: Transcript }
  | { type: 'server'; message: ServerMessage }
  | { type: 'local_user'; id: string; text: string }
  | { type: 'error'; message: string | null };

function initial(sessionId: string | null): SessionState {
  return {
    sessionId,
    cwd: null,
    status: 'connecting',
    meta: {},
    transcript: emptyTranscript(),
    pending: [],
    loadingHistory: Boolean(sessionId),
    error: null,
  };
}

function reducer(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case 'reset':
      return initial(action.sessionId);
    case 'history':
      return { ...state, transcript: action.transcript, loadingHistory: false };
    case 'local_user':
      return { ...state, transcript: addLocalUserTurn(state.transcript, action.id, action.text) };
    case 'error':
      return { ...state, error: action.message };
    case 'server': {
      const m = action.message;
      switch (m.type) {
        case 'attached': {
          let transcript = state.transcript;
          for (const msg of m.replay) transcript = applyMessage(transcript, msg);
          return {
            ...state,
            sessionId: m.sessionId,
            cwd: m.cwd,
            status: m.status,
            meta: { ...state.meta, ...m.meta },
            pending: m.pending,
            transcript,
            error: null,
          };
        }
        case 'message':
          return { ...state, transcript: applyMessage(state.transcript, m.message) };
        case 'permission_request':
          return state.pending.some((p) => p.requestId === m.request.requestId)
            ? state
            : { ...state, pending: [...state.pending, m.request] };
        case 'permission_resolved':
          return { ...state, pending: state.pending.filter((p) => p.requestId !== m.requestId) };
        case 'status':
          return { ...state, status: m.status };
        case 'meta':
          return { ...state, meta: { ...state.meta, ...m.meta } };
        case 'error':
          return {
            ...state,
            error: m.message,
            transcript: addNote(state.transcript, `err-${Date.now()}`, 'error', m.message),
          };
      }
    }
  }
  return state;
}

/**
 * Drives one chat: loads history, attaches to the live engine over the
 * WebSocket, and exposes the actions the UI needs.
 *
 * `requested` is the session the user picked (null = start a new one) and
 * `nonce` changes each time they pick, so picking "new" twice works.
 */
export function useSession(requested: string | null, nonce: number, onTurnEnd?: () => void) {
  const [state, dispatch] = useReducer(reducer, requested, initial);
  const activeId = useRef<string | null>(requested);
  const pendingNew = useRef(requested === null);
  const turnEnd = useRef(onTurnEnd);
  turnEnd.current = onTurnEnd;

  useEffect(() => {
    let cancelled = false;
    activeId.current = requested;
    pendingNew.current = requested === null;
    dispatch({ type: 'reset', sessionId: requested });

    const attach = () => ws.send({ type: 'attach', sessionId: activeId.current });

    (async () => {
      if (requested) {
        try {
          const history = await api.history(requested);
          if (cancelled) return;
          dispatch({ type: 'history', transcript: applyHistory(emptyTranscript(), history) });
        } catch (err) {
          if (cancelled) return;
          dispatch({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      }
      if (!cancelled) attach();
    })();

    const unsubscribe = ws.subscribe((m) => {
      if (m.type === 'attached') {
        if (activeId.current === null && pendingNew.current) {
          activeId.current = m.sessionId;
          pendingNew.current = false;
        } else if (m.sessionId !== activeId.current) return;
        dispatch({ type: 'server', message: m });
        return;
      }
      if (!('sessionId' in m) || m.sessionId !== activeId.current) {
        if (m.type === 'error' && !m.sessionId) dispatch({ type: 'server', message: m });
        return;
      }
      dispatch({ type: 'server', message: m });
      if (m.type === 'status' && (m.status === 'idle' || m.status === 'closed')) turnEnd.current?.();
    });
    const unsubState = ws.onState((s) => {
      if (s === 'open' && activeId.current) attach();
    });

    return () => {
      cancelled = true;
      unsubscribe();
      unsubState();
      if (activeId.current) ws.send({ type: 'detach', sessionId: activeId.current });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested, nonce]);

  const send = useCallback((text: string) => {
    const id = activeId.current;
    if (!id) return;
    const uuid = crypto.randomUUID();
    dispatch({ type: 'local_user', id: uuid, text });
    ws.send({ type: 'send', sessionId: id, text, uuid });
  }, []);

  const answerPermission = useCallback(
    (requestId: string, behavior: 'allow' | 'deny', always = false) => {
      const id = activeId.current;
      if (!id) return;
      ws.send({ type: 'permission', sessionId: id, requestId, behavior, always });
    },
    [],
  );

  const interrupt = useCallback(() => {
    const id = activeId.current;
    if (id) ws.send({ type: 'interrupt', sessionId: id });
  }, []);

  const setPermissionMode = useCallback((mode: PermissionMode) => {
    const id = activeId.current;
    if (id) ws.send({ type: 'set_permission_mode', sessionId: id, mode });
  }, []);

  const setModel = useCallback((model: string | null) => {
    const id = activeId.current;
    if (id) ws.send({ type: 'set_model', sessionId: id, model });
  }, []);

  return { state, send, answerPermission, interrupt, setPermissionMode, setModel };
}
