import type { ClientMessage, ServerMessage } from '@shared/protocol';
import { authExpired } from '@/lib/api';
import { authQuery, BASE } from '@/lib/page';

/** `expired`: the page's token is no longer accepted; only a fresh page helps. */
export type ConnectionState = 'connecting' | 'open' | 'closed' | 'expired';

type Listener = (message: ServerMessage) => void;
type StateListener = (state: ConnectionState) => void;

/** One WebSocket to the server, shared by the whole page, reconnecting on drop. */
export class WsClient {
  state: ConnectionState = 'connecting';
  private ws: WebSocket | null = null;
  private queue: ClientMessage[] = [];
  private listeners = new Set<Listener>();
  private stateListeners = new Set<StateListener>();
  private attempts = 0;
  private timer: number | null = null;

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.setState('connecting');
    const q = authQuery();
    const ws = new WebSocket(`${proto}://${location.host}${BASE}/ws${q ? `?${q}` : ''}`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.setState('open');
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      for (const fn of this.listeners) fn(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setState('closed');
      const delay = Math.min(5000, 500 * 2 ** this.attempts++);
      this.timer = window.setTimeout(() => {
        // a dead token would loop here forever; ask the API once before retrying
        void authExpired().then((dead) => {
          if (dead) this.setState('expired');
          else this.connect();
        });
      }, delay);
    };
    ws.onerror = () => ws.close();
  }

  send(message: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
    else this.queue.push(message);
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  onState(fn: StateListener) {
    this.stateListeners.add(fn);
    return () => {
      this.stateListeners.delete(fn);
    };
  }

  private setState(state: ConnectionState) {
    this.state = state;
    for (const fn of this.stateListeners) fn(state);
  }
}

export const ws = new WsClient();
