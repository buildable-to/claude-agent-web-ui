import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
import type { Account } from './accounts.js';
import type { LiveSession } from './live-session.js';
import type { SessionManager } from './session-manager.js';

type Attachment = { unsubscribe: () => void };

/** Turns a token (or a dev-mode account id) into the folder's session manager. */
export type Resolver = (
  token: string | undefined,
  devAccount: string | undefined,
) => { manager: SessionManager; dir: string; account?: Account };

export function attachWebSocket(server: Server, resolveCtx: Resolver, path = '/ws') {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    // One connection speaks for one account, decided at the handshake.
    let ctx: ReturnType<Resolver>;
    try {
      ctx = resolveCtx(url.searchParams.get('token') ?? undefined, url.searchParams.get('account') ?? undefined);
    } catch (err) {
      socket.write(`HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n${err instanceof Error ? err.message : ''}`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, ctx));
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, ctx: ReturnType<Resolver>) => {
    const sessions = ctx.manager;
    const attachments = new Map<string, Attachment>();
    const send = (message: ServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    const fail = (message: string, sessionId?: string) =>
      send({ type: 'error', message, ...(sessionId ? { sessionId } : {}) });

    ws.on('message', async (raw) => {
      let msg: ClientMessage;
      try {
        const parsed: unknown = JSON.parse(String(raw));
        if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { type?: unknown }).type !== 'string') {
          fail('Malformed message');
          return;
        }
        msg = parsed as ClientMessage;
      } catch {
        fail('Malformed message');
        return;
      }
      try {
        await handle(msg);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        fail(text, 'sessionId' in msg ? (msg.sessionId ?? undefined) : undefined);
      }
    });

    ws.on('close', () => {
      for (const a of attachments.values()) a.unsubscribe();
      attachments.clear();
    });

    async function handle(msg: ClientMessage) {
      switch (msg.type) {
        case 'attach': {
          const session = sessions.get(msg.sessionId);
          if (!session) {
            send({ type: 'not_live', sessionId: msg.sessionId });
            return;
          }
          attach(session);
          return;
        }
        case 'start': {
          if (ctx.account && msg.permissionMode === 'bypassPermissions') {
            throw new Error('Bypass mode is not available on a shared server');
          }
          // The token's project is signed; the page's is not. A token that names
          // a project pins it, otherwise the page may say which one.
          const pinned = ctx.account?.project;
          if (pinned && msg.project && msg.project !== pinned) {
            throw new Error('This page was opened for a different project');
          }
          const project = pinned ?? msg.project;
          const session = await sessions.open(msg.sessionId, {
            ...(msg.model ? { model: msg.model } : {}),
            ...(msg.permissionMode ? { permissionMode: msg.permissionMode } : {}),
            ...(project ? { project } : {}),
          });
          attach(session);
          const text = msg.text.trim();
          if (text) session.send(text, msg.uuid);
          return;
        }
        case 'detach': {
          attachments.get(msg.sessionId)?.unsubscribe();
          attachments.delete(msg.sessionId);
          return;
        }
        case 'send': {
          const session = requireLive(msg.sessionId);
          const text = msg.text.trim();
          if (!text) return;
          session.send(text, msg.uuid);
          return;
        }
        case 'permission': {
          const session = requireLive(msg.sessionId);
          if (!session.answerPermission(msg.requestId, msg.behavior, msg.always, msg.answers)) {
            fail('That permission request is no longer pending', msg.sessionId);
          }
          return;
        }
        case 'interrupt': {
          await requireLive(msg.sessionId).interrupt();
          return;
        }
        case 'set_permission_mode': {
          if (ctx.account && msg.mode === 'bypassPermissions') {
            throw new Error('Bypass mode is not available on a shared server');
          }
          await requireLive(msg.sessionId).setPermissionMode(msg.mode);
          return;
        }
        case 'set_model': {
          await requireLive(msg.sessionId).setModel(msg.model);
          return;
        }
      }
    }

    function attach(session: LiveSession) {
      attachments.get(session.sessionId)?.unsubscribe();
      const unsubscribe = session.subscribe(send);
      attachments.set(session.sessionId, { unsubscribe });
      send({
        type: 'attached',
        sessionId: session.sessionId,
        cwd: session.cwd,
        status: session.status,
        replay: session.replay,
        pending: session.pendingRequests,
        meta: session.meta,
      });
    }

    function requireLive(sessionId: string) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error('Session is not running. Reopen it to continue.');
      return session;
    }
  });

  return wss;
}
