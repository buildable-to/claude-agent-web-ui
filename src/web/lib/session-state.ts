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
  /** When the current turn began, on this page's clock; null between turns. */
  busySince: number | null;
};

const isBusy = (status: SessionStatus) => status === 'running' || status === 'requires_action';

/** The turn's start: kept while it runs, taken from the engine's own count
 *  when it first reports one (a reload mid-turn keeps the real time). */
function busySince(prev: number | null, status: SessionStatus, busyForMs?: number): number | null {
  if (!isBusy(status)) return null;
  return prev ?? Date.now() - (busyForMs ?? 0);
}

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
    busySince: null,
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
      return { ...state, status: 'starting', error: null, stopNotified: false, busySince: Date.now() };
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
          const midTurn = isBusy(m.status);
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
            busySince: m.status === 'starting' ? (state.busySince ?? Date.now()) : busySince(null, m.status, m.busyForMs),
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
            busySince: null,
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
            busySince: null,
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
            // 'starting' is the page's own guess until the engine speaks; the
            // turn it starts runs on from there
            busySince: m.status === 'starting' ? (state.busySince ?? Date.now()) : busySince(state.busySince, m.status, m.busyForMs),
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
            busySince: state.status === 'starting' ? null : state.busySince,
            transcript: addNote(state.transcript, `err-${Date.now()}`, 'error', m.message),
          };
      }
    }
  }
  return state;
}
