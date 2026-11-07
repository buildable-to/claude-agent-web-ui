// Claude logins: which Claude subscription the chats run on. The admin keeps a
// few long-lived login codes (`claude setup-token`) and picks the active one;
// every engine started after that gets it as CLAUDE_CODE_OAUTH_TOKEN. "server"
// is the login saved on the box (`claude` → /login), used when nothing else is
// picked. The codes live in one file on this machine (mode 600), never in the
// app's database, and never leave this service: the admin view sees only the
// last four characters.
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { claudeConfigDir } from './commands.js';
import { defaultClaudeConfigPath } from './accounts.js';

export const SERVER_LOGIN = 'server';

/** The last limit the engine reported while running on a login. */
export type LoginLimit = {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number; // ms
  type?: string;
  utilization?: number;
  at: number; // ms
};

type Stored = {
  id: string;
  name: string;
  token: string;
  addedAt: number;
};

type FileShape = {
  active: string;
  logins: Stored[];
  limits: Record<string, LoginLimit>;
};

/** What the admin view sees of a login: never the code itself. */
export type LoginRow = {
  id: string;
  name: string;
  tail: string;
  addedAt?: number;
  active: boolean;
  limit?: LoginLimit;
};

export class LoginError extends Error {
  readonly status = 400;
}

const TOKEN = /^sk-ant-oat\d\d-[A-Za-z0-9_-]{20,}$/;

export class Logins {
  private data: FileShape;

  constructor(
    readonly file: string,
    /** Claude Code's .claude.json, which names the box's own login. */
    private readonly claudeJson: string = defaultClaudeConfigPath(),
  ) {
    this.data = this.read();
  }

  private read(): FileShape {
    if (!existsSync(this.file)) return { active: SERVER_LOGIN, logins: [], limits: {} };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<FileShape>;
      const logins = Array.isArray(raw.logins) ? raw.logins : [];
      const active = logins.some((l) => l.id === raw.active) ? (raw.active as string) : SERVER_LOGIN;
      return { active, logins, limits: raw.limits ?? {} };
    } catch (err) {
      console.error(`[logins] unreadable ${this.file}: ${String(err)} — using the server login`);
      return { active: SERVER_LOGIN, logins: [], limits: {} };
    }
  }

  private write() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  list(): LoginRow[] {
    const row = (id: string, name: string, tail: string, addedAt?: number): LoginRow => ({
      id,
      name,
      tail,
      ...(addedAt ? { addedAt } : {}),
      active: this.data.active === id,
      ...(this.data.limits[id] ? { limit: this.data.limits[id] } : {}),
    });
    return [
      row(SERVER_LOGIN, serverLoginEmail(this.claudeJson) ?? 'Saved on the server', ''),
      ...this.data.logins.map((l) => row(l.id, l.name, l.token.slice(-4), l.addedAt)),
    ];
  }

  add(name: string, token: string): LoginRow {
    const n = name.trim();
    const t = token.trim();
    if (!n) throw new LoginError('give the login a name (its email)');
    if (n.length > 120) throw new LoginError('name too long');
    if (!TOKEN.test(t)) throw new LoginError('that is not a login code — run `claude setup-token` and paste the code it prints (sk-ant-oat…)');
    if (this.data.logins.some((l) => l.token === t)) throw new LoginError('this login is already in the list');
    const stored: Stored = { id: randomUUID().slice(0, 8), name: n, token: t, addedAt: Date.now() };
    this.data.logins.push(stored);
    this.write();
    return this.list().find((r) => r.id === stored.id) as LoginRow;
  }

  use(id: string) {
    if (id !== SERVER_LOGIN && !this.data.logins.some((l) => l.id === id)) throw new LoginError('no such login');
    this.data.active = id;
    this.write();
  }

  remove(id: string) {
    if (id === SERVER_LOGIN) throw new LoginError('the server login cannot be removed');
    const before = this.data.logins.length;
    this.data.logins = this.data.logins.filter((l) => l.id !== id);
    if (this.data.logins.length === before) throw new LoginError('no such login');
    delete this.data.limits[id];
    if (this.data.active === id) this.data.active = SERVER_LOGIN;
    this.write();
  }

  /** The login a new engine runs on, and the env that says so. */
  current(): { id: string; env: Record<string, string> } {
    const l = this.data.logins.find((x) => x.id === this.data.active);
    return l ? { id: l.id, env: { CLAUDE_CODE_OAUTH_TOKEN: l.token } } : { id: SERVER_LOGIN, env: {} };
  }

  noteLimit(id: string, info: { status: LoginLimit['status']; resetsAt?: number; rateLimitType?: string; utilization?: number }) {
    if (id !== SERVER_LOGIN && !this.data.logins.some((l) => l.id === id)) return;
    const prev = this.data.limits[id];
    const next: LoginLimit = {
      status: info.status,
      // the engine reports seconds
      ...(info.resetsAt ? { resetsAt: info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt } : {}),
      ...(info.rateLimitType ? { type: info.rateLimitType } : {}),
      ...(typeof info.utilization === 'number' ? { utilization: info.utilization } : {}),
      at: Date.now(),
    };
    this.data.limits[id] = next;
    // write when it changes, not on every event
    if (!prev || prev.status !== next.status || prev.resetsAt !== next.resetsAt || prev.type !== next.type) this.write();
  }
}

/** The email of the login saved on the box (`claude` → /login), if any. */
export function serverLoginEmail(path: string): string | undefined {
  try {
    const email = (JSON.parse(readFileSync(path, 'utf8')) as { oauthAccount?: { emailAddress?: unknown } }).oauthAccount?.emailAddress;
    return typeof email === 'string' && email ? email : undefined;
  } catch {
    return undefined;
  }
}

let shared: Logins | undefined;

/** The one store this service uses (CLAUDE_LOGINS_FILE, or next to the Claude home). */
export function sharedLogins(): Logins {
  shared ??= new Logins(process.env.CLAUDE_LOGINS_FILE ?? join(claudeConfigDir(), 'buildable-logins.json'));
  return shared;
}
