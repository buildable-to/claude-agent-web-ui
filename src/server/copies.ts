import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Two versions of this service run side by side across a deploy: the new
 *  one takes the traffic, the old one finishes its work and exits (ezdxf-flask
 *  #1457). An account's folder has one writer, so an account is on exactly one
 *  copy at a time. This is the shared record of who that is: one file per
 *  running copy and one owner file per account, in a folder every copy reads.
 *  Without a folder (a laptop) there is one copy and it owns everything. */

export type CopyInfo = { port: number; pid: number; startedAt: number; retiring: boolean };

type Options = {
  /** The shared folder (AGENT_COPIES_DIR); undefined = one copy, no record. */
  dir?: string;
  port: number;
  pid?: number;
  /** Whether a process is alive (tests). */
  alive?: (pid: number) => boolean;
};

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const OWNER = /^owner-(.+)$/;

export class Copies {
  readonly enabled: boolean;
  readonly port: number;
  private readonly dir: string;
  private readonly pid: number;
  private readonly alive: (pid: number) => boolean;
  private retiringNow = false;
  /** True when this port's last lifetime died while retiring: nothing points
   *  at it any more, so it must not come back as a serving copy. */
  readonly diedRetiring: boolean;

  constructor(options: Options) {
    this.enabled = Boolean(options.dir);
    this.dir = options.dir ?? '';
    this.port = options.port;
    this.pid = options.pid ?? process.pid;
    this.alive = options.alive ?? processAlive;
    let diedRetiring = false;
    if (this.enabled) {
      mkdirSync(this.dir, { recursive: true });
      const before = this.read(this.port);
      diedRetiring = Boolean(before?.retiring) && before?.pid !== this.pid;
      this.write({ port: this.port, pid: this.pid, startedAt: Date.now(), retiring: false });
    }
    this.diedRetiring = diedRetiring;
  }

  get retiring() {
    return this.retiringNow;
  }

  /** Told to stop: serve what this copy owns, take nothing new. */
  retire() {
    this.retiringNow = true;
    if (!this.enabled) return;
    const mine = this.read(this.port);
    this.write({ port: this.port, pid: this.pid, startedAt: mine?.startedAt ?? Date.now(), retiring: true });
  }

  /** Leave the record: this copy's file and every owner file it holds. */
  leave() {
    if (!this.enabled) return;
    for (const account of this.owned()) this.release(account);
    rmSync(this.copyPath(this.port), { force: true });
  }

  /** The other copies that are running now. A dead one's file is removed. */
  others(): CopyInfo[] {
    if (!this.enabled) return [];
    const out: CopyInfo[] = [];
    for (const name of readdirSync(this.dir)) {
      const m = /^copy-(\d+)\.json$/.exec(name);
      if (!m || Number(m[1]) === this.port) continue;
      const info = this.read(Number(m[1]));
      if (info && this.alive(info.pid)) out.push(info);
      else rmSync(join(this.dir, name), { force: true });
    }
    return out;
  }

  /** The port of the live copy that owns the account, or null for nobody.
   *  An owner file a dead copy left is not an owner. */
  ownerOf(account: string): number | null {
    if (!this.enabled) return this.port;
    const port = this.readOwner(account);
    if (port === null) return null;
    if (port === this.port) return port;
    const info = this.read(port);
    return info && this.alive(info.pid) ? port : null;
  }

  /** Take the account if nobody live has it. Returns the owner's port: this
   *  copy's when the claim held, another's when that copy got there first.
   *  A retiring copy takes nothing new: it returns null for an account it
   *  does not already own. */
  claim(account: string): number | null {
    if (!this.enabled) return this.port;
    for (let attempt = 0; attempt < 3; attempt++) {
      const owner = this.ownerOf(account);
      if (owner !== null) return owner;
      if (this.retiringNow) return null;
      // a dead copy's file goes first, then one atomic create decides the race
      if (this.readOwner(account) !== null) rmSync(this.ownerPath(account), { force: true });
      try {
        writeFileSync(this.ownerPath(account), String(this.port), { flag: 'wx', mode: 0o600 });
        return this.port;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    return this.ownerOf(account);
  }

  /** Give the account up (only this copy's own claim is removed). */
  release(account: string) {
    if (!this.enabled) return;
    if (this.readOwner(account) === this.port) rmSync(this.ownerPath(account), { force: true });
  }

  /** The accounts this copy holds. */
  owned(): string[] {
    if (!this.enabled) return [];
    return this.owners().filter(([, port]) => port === this.port).map(([account]) => account);
  }

  /** Accounts whose owner file names a copy that is gone. */
  orphaned(): string[] {
    if (!this.enabled) return [];
    return this.owners().filter(([account, port]) => port !== this.port && this.ownerOf(account) === null).map(([account]) => account);
  }

  private owners(): [string, number][] {
    const out: [string, number][] = [];
    for (const name of readdirSync(this.dir)) {
      const m = OWNER.exec(name);
      if (!m?.[1]) continue;
      const port = this.readOwner(m[1]);
      if (port !== null) out.push([m[1], port]);
    }
    return out;
  }

  private readOwner(account: string): number | null {
    try {
      const port = Number(readFileSync(this.ownerPath(account), 'utf8').trim());
      return Number.isInteger(port) && port > 0 ? port : null;
    } catch {
      return null;
    }
  }

  private read(port: number): CopyInfo | null {
    const path = this.copyPath(port);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as CopyInfo;
    } catch {
      return null;
    }
  }

  private write(info: CopyInfo) {
    const path = this.copyPath(info.port);
    const tmp = `${path}.${this.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(info) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  }

  private copyPath(port: number) {
    return join(this.dir, `copy-${port}.json`);
  }

  private ownerPath(account: string) {
    return join(this.dir, `owner-${account}`);
  }
}
