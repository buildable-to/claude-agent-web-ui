import type { ClientMessage, ServerMessage } from '@shared/protocol';
import { page } from '@/lib/page';

export type ConnectionState = 'connecting' | 'open' | 'closed';

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
    const query = page.token ? `?token=${encodeURIComponent(page.token)}` : '';
    const ws = new WebSocket(`${proto}://${location.host}/ws${query}`);
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
      this.timer = window.setTimeout(() => this.connect(), delay);
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
