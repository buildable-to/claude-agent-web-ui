import type { PermissionMode, PermissionRequest, ServerMessage, SessionMeta, SessionStatus } from '@shared/protocol';
import {
  addLocalUserTurn, addNote, addStoppedWork, applyMessage, closeStoppedWork, emptyTranscript, markCut,
  reopenLastTurn, stoppedWorkNotices, stopOrphanTasks, type Transcript,
} from './transcript';

export type SessionState = {
  /** Known session id; null until a brand-new session has been started. */
  sessionId: string | null;
  cwd: string | null;
  /** True while this page is subscribed to a running engine. */
  attached: boolean;
  status: SessionStatus | 'connecting';
  meta: SessionMeta;
  transcript: Transcript;
  pending: PermissionRequest[];
  loadingHistory: boolean;
  error: string | null;
  /** This engine's closure already has a precise explanation; history alone does not set it. */
  stopNotified: boolean;
};

type Action =
  | { type: 'reset'; sessionId: string | null }
  | { type: 'history'; transcript: Transcript }
  | { type: 'server'; message: ServerMessage }
  | { type: 'local_user'; id: string; text: string }
  | { type: 'starting' }
  | { type: 'choose'; model?: string | null; permissionMode?: PermissionMode }
  | { type: 'error'; message: string | null };

export function initialSessionState(sessionId: string | null): SessionState {
  return {
    sessionId,
    cwd: null,
    attached: false,
    status: sessionId ? 'connecting' : 'idle',
    meta: {},
    transcript: emptyTranscript(),
    pending: [],
    loadingHistory: Boolean(sessionId),
    error: null,
    stopNotified: false,
  };
}

export function sessionReducer(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case 'reset':
      return initialSessionState(action.sessionId);
    case 'history': {
      // A stop can arrive while the earlier HTTP request is still pending.
      // Preserve that live evidence when the older history snapshot lands.
      let transcript = action.transcript;
      for (const notice of stoppedWorkNotices(state.transcript)) transcript = addStoppedWork(transcript, notice);
      if (state.stopNotified) transcript = closeStoppedWork(transcript, []);
      return { ...state, transcript, loadingHistory: false };
    }
    case 'local_user':
      return { ...state, transcript: addLocalUserTurn(state.transcript, action.id, action.text) };
    case 'starting':
      return { ...state, status: 'starting', error: null, stopNotified: false };
    case 'choose':
      return {
        ...state,
        meta: {
          ...state.meta,
          ...(action.model !== undefined ? { model: action.model ?? undefined } : {}),
          ...(action.permissionMode ? { permissionMode: action.permissionMode } : {}),
        },
      };
    case 'error':
      return { ...state, error: action.message };
    case 'server': {
      const m = action.message;
      switch (m.type) {
        case 'attached': {
          // History closes every turn; if the engine is mid-turn (working, or
          // waiting on a permission), its next messages belong to the last
          // turn, not to a new one.
          const midTurn = m.status === 'running' || m.status === 'requires_action';
          let transcript = midTurn ? reopenLastTurn(state.transcript) : state.transcript;
          for (const msg of m.replay) transcript = applyMessage(transcript, msg);
          for (const notice of m.stoppedWork ?? []) transcript = addStoppedWork(transcript, notice);
          return {
            ...state,
            sessionId: m.sessionId,
            cwd: m.cwd,
            attached: true,
            status: m.status,
            meta: { ...state.meta, ...m.meta },
            pending: m.pending,
            transcript,
            error: null,
            stopNotified: false,
          };
        }
        case 'not_live': {
          // No engine holds this conversation. If its last turn never
          // finished, the engine died under it (a restart): say so.
          const notices = m.stoppedWork ?? [];
          return {
            ...state,
            attached: false,
            status: 'idle',
            pending: [],
            stopNotified: notices.length > 0,
            transcript: notices.length > 0
              ? closeStoppedWork(state.transcript, notices)
              : stopOrphanTasks(markCut(state.transcript, `cut-${m.sessionId}-${state.transcript.turns.length}`)),
          };
        }
        case 'work_stopped':
          // The same incident may arrive from history and a reconnect. It
          // never gets to close an engine the engineer has since resumed.
          if (stoppedWorkNotices(state.transcript).some((notice) => notice.id === m.notice.id)) return state;
          return {
            ...state,
            attached: false,
            status: 'closed',
            pending: [],
            stopNotified: true,
            transcript: closeStoppedWork(state.transcript, [m.notice]),
          };
        case 'message':
          return { ...state, transcript: applyMessage(state.transcript, m.message) };
        case 'permission_request':
          return state.pending.some((p) => p.requestId === m.request.requestId)
            ? state
            : { ...state, pending: [...state.pending, m.request] };
        case 'permission_resolved':
          return { ...state, pending: state.pending.filter((p) => p.requestId !== m.requestId) };
        case 'status':
          return {
            ...state,
            status: m.status,
            attached: m.status === 'closed' ? false : state.attached,
            pending: m.status === 'closed' ? [] : state.pending,
            transcript:
              m.status === 'closed'
                ? state.stopNotified
                  ? closeStoppedWork(state.transcript, [])
                  : stopOrphanTasks(markCut(state.transcript, `cut-${m.sessionId}-${state.transcript.turns.length}`))
                : state.transcript,
          };
        case 'meta':
          return { ...state, meta: { ...state.meta, ...m.meta } };
        case 'error':
          return {
            ...state,
            error: m.message,
            status: state.status === 'starting' ? 'idle' : state.status,
            transcript: addNote(state.transcript, `err-${Date.now()}`, 'error', m.message),
          };
      }
    }
  }
  return state;
}
