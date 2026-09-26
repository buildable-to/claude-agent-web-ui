import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ClientMessage, PermissionMode } from '@shared/protocol';
import { api } from '@/lib/api';
import { page } from '@/lib/page';
import { applyHistory, emptyTranscript } from '@/lib/transcript';
import { initialSessionState, sessionReducer } from '@/lib/session-state';
import { ws } from '@/lib/ws';

export type { SessionState } from '@/lib/session-state';

type Action = Parameters<typeof sessionReducer>[1];
type Conversation = { id: string | null; attached: boolean; startId?: string; stopping?: boolean; loading?: boolean; buffered?: Action[] };
type PendingStart = {
  conversation: Conversation;
  request: Extract<ClientMessage, { type: 'start' }>;
  followups: { text: string; uuid: string }[];
  failed: boolean;
  error?: string;
  cancelled: boolean;
};

/** Starts lazily; pending starts keep their identity across reconnects and
 * navigation, so follow-ups always reach the conversation they were typed in. */
export function useSession(requested: string | null, nonce: number, onTurnEnd?: () => void) {
  const [state, dispatch] = useReducer(sessionReducer, requested, initialSessionState);
  const [pendingSendCount, setPendingSendCount] = useState(0);
  const [stopping, setStopping] = useState(false);
  const chosen = useRef<{ model?: string; permissionMode?: PermissionMode }>({});
  const current = useRef<Conversation>({ id: requested, attached: false });
  const starts = useRef(new Map<string, PendingStart>());
  const turnEnd = useRef(onTurnEnd);
  turnEnd.current = onTurnEnd;

  useEffect(() => {
    const unsubscribe = ws.subscribe((m) => {
      const conversation = current.current;
      const deliver = (action: Action) => {
        if (conversation.loading) (conversation.buffered ??= []).push(action);
        else dispatch(action);
      };
      if (m.type === 'attached') {
        const pending = m.requestId ? starts.current.get(m.requestId) : undefined;
        if (pending) {
          const owner = pending.conversation;
          owner.id = m.sessionId;
          owner.attached = true;
          delete owner.startId;
          starts.current.delete(m.requestId!);
          if (pending.cancelled) {
            ws.send({ type: 'stop_work', sessionId: m.sessionId });
          } else {
            for (const prompt of pending.followups) ws.send({ type: 'send', sessionId: m.sessionId, ...prompt });
          }
          if (owner !== conversation) {
            // The engineer may have left and selected this same session again.
            // Its old acknowledgement must not detach the new subscription.
            if (conversation.id !== m.sessionId) ws.send({ type: 'detach', sessionId: m.sessionId });
            else {
              // A fresh session may become selectable before its first reply.
              // Preserve the locally queued words when selecting it by ID.
              deliver({ type: 'local_user', id: pending.request.uuid!, text: pending.request.text });
              for (const prompt of pending.followups) deliver({ type: 'local_user', id: prompt.uuid, text: prompt.text });
            }
            return;
          }
          setPendingSendCount(0);
        } else if (m.requestId || conversation.startId || m.sessionId !== conversation.id) {
          // A duplicate/late start acknowledgement cannot select another chat.
          return;
        }
        conversation.attached = true;
        deliver({ type: 'server', message: m });
        return;
      }
      if (m.type === 'error' && m.requestId) {
        const pending = starts.current.get(m.requestId);
        if (!pending) return;
        pending.failed = true;
        pending.error = m.message;
        if (pending.conversation !== conversation) return;
        if (pending.cancelled) {
          starts.current.delete(m.requestId);
          delete conversation.startId;
          setPendingSendCount(0);
          conversation.stopping = false;
          setStopping(false);
        }
        deliver({ type: 'server', message: { ...m, message: pending.cancelled ? m.message : `${m.message} Your messages remain queued; retry sending when ready.` } });
        return;
      }
      if (!('sessionId' in m) || m.sessionId !== conversation.id) {
        if (m.type === 'error' && !m.sessionId) deliver({ type: 'server', message: m });
        return;
      }
      if (m.type === 'not_live' || m.type === 'work_stopped' || (m.type === 'status' && m.status === 'closed')) {
        conversation.attached = false;
        conversation.stopping = false;
        setStopping(false);
      }
      deliver({ type: 'server', message: m });
      if (m.type === 'status' && (m.status === 'idle' || m.status === 'closed')) turnEnd.current?.();
    });
    const unsubState = ws.onState((s) => {
      if (s !== 'open') return;
      // Lost attachment replies are retried with the same request and prompt
      // IDs. The account manager and live engine deduplicate both boundaries.
      for (const pending of starts.current.values()) if (!pending.failed) ws.send(pending.request);
      const conversation = current.current;
      if (conversation.id && conversation.attached && !conversation.startId) ws.send({ type: 'attach', sessionId: conversation.id });
    });
    return () => { unsubscribe(); unsubState(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const pending = requested ? [...starts.current.values()].find((start) => start.conversation.id === requested) : undefined;
    const conversation: Conversation = { id: requested, attached: false, loading: Boolean(requested), buffered: [] };
    if (pending) {
      conversation.startId = pending.request.requestId;
      conversation.stopping = pending.cancelled;
      pending.conversation = conversation;
    }
    current.current = conversation;
    setStopping(pending?.cancelled ?? false);
    setPendingSendCount(pending && !pending.cancelled ? 1 + pending.followups.length : 0);
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
        if (cancelled) return;
        // HTTP history can finish after a correlated attachment and live SDK
        // messages. Apply the snapshot first, then preserve pending local words
        // and every newer UI event in arrival order. Transport work needn't wait.
        if (pending && !pending.cancelled) {
          dispatch({ type: 'local_user', id: pending.request.uuid!, text: pending.request.text });
          for (const prompt of pending.followups) dispatch({ type: 'local_user', id: prompt.uuid, text: prompt.text });
          if (conversation.startId) {
            dispatch({ type: 'starting' });
            if (pending.failed) dispatch({ type: 'server', message: { type: 'error', message: `${pending.error} Your messages remain queued; retry sending when ready.` } });
          }
        }
        conversation.loading = false;
        for (const action of conversation.buffered ?? []) dispatch(action);
        conversation.buffered = [];
        if (!conversation.startId && !conversation.attached) ws.send({ type: 'attach', sessionId: requested });
      })();
    }
    return () => {
      cancelled = true;
      if (conversation.id && conversation.attached) ws.send({ type: 'detach', sessionId: conversation.id });
    };
  }, [requested, nonce]);

  const retrySend = useCallback(() => {
    const startId = current.current.startId;
    const pending = startId ? starts.current.get(startId) : undefined;
    if (!pending || pending.cancelled) return;
    pending.failed = false;
    dispatch({ type: 'starting' });
    ws.send(pending.request);
  }, []);

  const send = useCallback((text: string) => {
    const conversation = current.current;
    const pending = conversation.startId ? starts.current.get(conversation.startId) : undefined;
    if (pending?.cancelled || conversation.stopping) return false;
    const uuid = crypto.randomUUID();
    dispatch({ type: 'local_user', id: uuid, text });
    if (pending) {
      pending.followups.push({ text, uuid });
      setPendingSendCount(1 + pending.followups.length);
      if (pending.failed) retrySend();
      return true;
    }
    if (conversation.attached && conversation.id) {
      ws.send({ type: 'send', sessionId: conversation.id, text, uuid });
      return true;
    }
    const requestId = crypto.randomUUID();
    conversation.startId = requestId;
    const request: Extract<ClientMessage, { type: 'start' }> = {
      type: 'start', sessionId: conversation.id, requestId, text, uuid,
      ...chosen.current,
      ...(page.project ? { project: page.project } : {}),
    };
    starts.current.set(requestId, { conversation, request, followups: [], failed: false, cancelled: false });
    setPendingSendCount(1);
    dispatch({ type: 'starting' });
    ws.send(request);
    return true;
  }, [retrySend]);

  const answerPermission = useCallback(
    (requestId: string, behavior: 'allow' | 'deny', always = false, answers?: Record<string, string>) => {
      const id = current.current.id;
      if (id) ws.send({ type: 'permission', sessionId: id, requestId, behavior, always, ...(answers ? { answers } : {}) });
    }, [],
  );

  const interrupt = useCallback(() => {
    const conversation = current.current;
    if (conversation.id && conversation.attached) ws.send({ type: 'interrupt', sessionId: conversation.id });
  }, []);

  const stopWork = useCallback(() => {
    const conversation = current.current;
    const pending = conversation.startId ? starts.current.get(conversation.startId) : undefined;
    if (pending) {
      pending.cancelled = true;
      conversation.stopping = true;
      setStopping(true);
      pending.followups = [];
      setPendingSendCount(0);
      return;
    }
    if (conversation.id && conversation.attached) {
      conversation.stopping = true;
      setStopping(true);
      ws.send({ type: 'stop_work', sessionId: conversation.id });
    }
  }, []);

  const setPermissionMode = useCallback((mode: PermissionMode) => {
    const conversation = current.current;
    if (conversation.id && conversation.attached) {
      ws.send({ type: 'set_permission_mode', sessionId: conversation.id, mode });
      return;
    }
    chosen.current.permissionMode = mode;
    dispatch({ type: 'choose', permissionMode: mode });
  }, []);

  const setModel = useCallback((model: string | null) => {
    const conversation = current.current;
    if (conversation.id && conversation.attached) {
      ws.send({ type: 'set_model', sessionId: conversation.id, model });
      return;
    }
    if (model) chosen.current.model = model;
    else delete chosen.current.model;
    dispatch({ type: 'choose', model });
  }, []);

  return { state, send, answerPermission, interrupt, stopWork, stopping, pendingSendCount, retrySend, setPermissionMode, setModel };
}
