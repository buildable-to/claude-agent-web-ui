import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { PermissionMode } from '@shared/protocol';
import { api } from '@/lib/api';
import { page } from '@/lib/page';
import { applyHistory, emptyTranscript } from '@/lib/transcript';
import { initialSessionState, sessionReducer } from '@/lib/session-state';
import { ws } from '@/lib/ws';

export type { SessionState } from '@/lib/session-state';

/**
 * Drives one chat. Loads history for an existing session and subscribes to
 * its engine if one is running. An engine is only started (or resumed) when
 * the user sends a message, so opening the page or browsing old sessions
 * never spawns processes.
 *
 * `requested` is the session the user picked (null = new) and `nonce`
 * changes each time they pick, so picking "new" twice in a row works.
 */
export function useSession(requested: string | null, nonce: number, onTurnEnd?: () => void) {
  const [state, dispatch] = useReducer(sessionReducer, requested, initialSessionState);
  const chosen = useRef<{ model?: string; permissionMode?: PermissionMode }>({});
  const activeId = useRef<string | null>(requested);
  const attached = useRef(false);
  const awaitingNew = useRef(false);
  const turnEnd = useRef(onTurnEnd);
  turnEnd.current = onTurnEnd;

  useEffect(() => {
    let cancelled = false;
    activeId.current = requested;
    attached.current = false;
    awaitingNew.current = false;
    dispatch({ type: 'reset', sessionId: requested });

    if (requested) {
      void (async () => {
        try {
          const history = await api.history(requested);
          if (cancelled) return;
          dispatch({ type: 'history', transcript: applyHistory(emptyTranscript(), history) });
        } catch (err) {
          if (cancelled) return;
          dispatch({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
        if (!cancelled) ws.send({ type: 'attach', sessionId: requested });
      })();
    }

    const unsubscribe = ws.subscribe((m) => {
      if (m.type === 'attached') {
        if (activeId.current === null && awaitingNew.current) {
          activeId.current = m.sessionId;
          awaitingNew.current = false;
        } else if (m.sessionId !== activeId.current) return;
        attached.current = true;
        dispatch({ type: 'server', message: m });
        return;
      }
      if (!('sessionId' in m) || m.sessionId !== activeId.current) {
        if (m.type === 'error' && !m.sessionId) dispatch({ type: 'server', message: m });
        return;
      }
      if (m.type === 'not_live' || (m.type === 'status' && m.status === 'closed')) {
        attached.current = false;
      }
      dispatch({ type: 'server', message: m });
      if (m.type === 'status' && (m.status === 'idle' || m.status === 'closed')) turnEnd.current?.();
    });
    const unsubState = ws.onState((s) => {
      // After a reconnect, re-subscribe to the engine if we had one.
      if (s === 'open' && activeId.current && attached.current) {
        ws.send({ type: 'attach', sessionId: activeId.current });
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
      unsubState();
      if (activeId.current && attached.current) ws.send({ type: 'detach', sessionId: activeId.current });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested, nonce]);

  const send = useCallback((text: string) => {
    const uuid = crypto.randomUUID();
    dispatch({ type: 'local_user', id: uuid, text });
    if (attached.current && activeId.current) {
      ws.send({ type: 'send', sessionId: activeId.current, text, uuid });
      return;
    }
    if (activeId.current === null) awaitingNew.current = true;
    dispatch({ type: 'starting' });
    ws.send({
      type: 'start',
      sessionId: activeId.current,
      text,
      uuid,
      ...chosen.current,
      ...(page.project ? { project: page.project } : {}),
    });
  }, []);

  const answerPermission = useCallback(
    (requestId: string, behavior: 'allow' | 'deny', always = false, answers?: Record<string, string>) => {
      const id = activeId.current;
      if (!id) return;
      ws.send({ type: 'permission', sessionId: id, requestId, behavior, always, ...(answers ? { answers } : {}) });
    },
    [],
  );

  const interrupt = useCallback(() => {
    const id = activeId.current;
    if (id && attached.current) ws.send({ type: 'interrupt', sessionId: id });
  }, []);

  const setPermissionMode = useCallback((mode: PermissionMode) => {
    const id = activeId.current;
    if (id && attached.current) {
      ws.send({ type: 'set_permission_mode', sessionId: id, mode });
      return;
    }
    // No engine yet: remember the choice for when it starts.
    chosen.current.permissionMode = mode;
    dispatch({ type: 'choose', permissionMode: mode });
  }, []);

  const setModel = useCallback((model: string | null) => {
    const id = activeId.current;
    if (id && attached.current) {
      ws.send({ type: 'set_model', sessionId: id, model });
      return;
    }
    if (model) chosen.current.model = model;
    else delete chosen.current.model;
    dispatch({ type: 'choose', model });
  }, []);

  return { state, send, answerPermission, interrupt, setPermissionMode, setModel };
}
