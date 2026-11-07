// Connect a Claude account from the admin page, no terminal: this service runs
// Claude Code's own `claude setup-token` sign-in in a pseudo-terminal, hands
// the admin its sign-in link, and types back the code Claude's page shows.
// The long-lived code it prints is saved to the logins (logins.ts). The
// sign-in runs with a throwaway Claude home, so the box's own login and the
// chats' history are never touched.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class ConnectError extends Error {
  readonly status = 400;
}

const URL_RE = /https:\/\/claude\.(?:com|ai)\/[^\s\x07\x1b"']*oauth\/authorize\?[^\s\x07\x1b"']+/;
const TOKEN_RE = /sk-ant-oat\d\d-[A-Za-z0-9_-]{20,}/;
const ERROR_RE = /(OAuth error:[^\n]*|Invalid code[^\n]*)/;
const FLOW_TTL_MS = 10 * 60 * 1000;

/** What the terminal printed, without colours, cursor moves and link
 *  wrappers (a link's text is the link itself). */
export function plain(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?>]*[a-zA-Z]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\r/g, '\n');
}

type Flow = {
  id: string;
  child: ChildProcess;
  home: string;
  out: string;
  url?: string;
  started: number;
  done: boolean;
};

/** The command that runs the sign-in: `claude` on PATH (as the box installs
 *  it) inside `script`, which gives it the terminal it insists on. */
export type Runner = (env: NodeJS.ProcessEnv) => ChildProcess;

const defaultRunner: Runner = (env) =>
  spawn('script', ['-qfc', 'stty cols 2000 rows 50; claude setup-token', '/dev/null'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

export class Connector {
  private flows = new Map<string, Flow>();

  constructor(private readonly run: Runner = defaultRunner) {}

  /** Start a sign-in; resolves with its link once Claude Code prints it. */
  async start(): Promise<{ id: string; url: string }> {
    this.sweep();
    const home = mkdtempSync(join(tmpdir(), 'claude-connect-'));
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG ?? 'C.UTF-8',
      TERM: 'xterm-256color',
      CLAUDE_CONFIG_DIR: home,
      // never try to open a browser on the server
      BROWSER: '/bin/false',
    };
    const child = this.run(env);
    const flow: Flow = { id: randomUUID().slice(0, 12), child, home, out: '', started: Date.now(), done: false };
    this.flows.set(flow.id, flow);
    const onData = (b: Buffer) => {
      flow.out += plain(b.toString('utf8'));
      if (flow.out.length > 200_000) flow.out = flow.out.slice(-100_000);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', () => {
      flow.done = true;
    });
    child.on('error', (err) => {
      flow.done = true;
      flow.out += `\n${String(err)}`;
    });
    const url = await this.waitFor(flow, () => flow.out.match(URL_RE)?.[0], 30_000);
    if (!url) {
      this.end(flow);
      throw new Error('Claude sign-in did not start (is `claude` installed on the server?)');
    }
    flow.url = url;
    return { id: flow.id, url };
  }

  /** Type the code Claude's page showed; resolves with the long-lived login code. */
  async finish(id: string, code: string): Promise<string> {
    const flow = this.flows.get(id);
    if (!flow || flow.done) throw new ConnectError('this sign-in has expired — press Connect again');
    const c = code.trim();
    if (!c || c.length > 500 || /\s/.test(c)) throw new ConnectError('paste the code Claude showed after you signed in');
    const from = flow.out.length;
    flow.child.stdin?.write(`${c}\r`);
    const tail = () => flow.out.slice(from);
    const result = await this.waitFor(
      flow,
      () => tail().match(TOKEN_RE)?.[0] ?? (tail().match(ERROR_RE) ? 'error' : undefined),
      60_000,
    );
    if (result && result !== 'error') {
      this.end(flow);
      return result;
    }
    const why = tail().match(ERROR_RE)?.[1]?.trim();
    this.end(flow);
    // a retry needs a fresh link (each sign-in has its own), so start over
    throw new ConnectError(why ? 'Claude did not accept that code — press Connect and sign in again' : 'Claude did not answer — press Connect again');
  }

  cancel(id: string) {
    const flow = this.flows.get(id);
    if (flow) this.end(flow);
  }

  private waitFor<T>(flow: Flow, check: () => T | undefined, ms: number): Promise<T | undefined> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const v = check();
        if (v !== undefined) return resolve(v);
        if (flow.done || Date.now() - t0 > ms) return resolve(check());
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  private end(flow: Flow) {
    flow.done = true;
    this.flows.delete(flow.id);
    try {
      flow.child.kill('SIGTERM');
    } catch {
      // already gone
    }
    if (existsSync(flow.home)) rmSync(flow.home, { recursive: true, force: true });
  }

  private sweep() {
    const now = Date.now();
    for (const f of this.flows.values()) if (f.done || now - f.started > FLOW_TTL_MS) this.end(f);
  }
}

let shared: Connector | undefined;
export function sharedConnector(): Connector {
  shared ??= new Connector();
  return shared;
}
