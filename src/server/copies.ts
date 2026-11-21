import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  /** When this lifetime began: an owner file names the port and this time, so
   *  what an earlier lifetime on the same port held is nobody's until taken. */
  private readonly startedAt: number;
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
    this.startedAt = Date.now();
    if (this.enabled) {
      mkdirSync(this.dir, { recursive: true });
      const before = this.read(this.port);
      diedRetiring = Boolean(before?.retiring) && before?.pid !== this.pid;
      this.write({ port: this.port, pid: this.pid, startedAt: this.startedAt, retiring: false });
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
    this.write({ port: this.port, pid: this.pid, startedAt: mine?.startedAt ?? this.startedAt, retiring: true });
  }

  /** Leave the record: this copy's file and every owner file it holds. */
  leave() {
    if (!this.enabled) return;
    // also what an earlier lifetime of this port left behind
    for (const account of this.owners()) {
      if (this.readOwner(account)?.port === this.port) rmSync(this.ownerPath(account), { force: true });
    }
    rmSync(this.copyPath(this.port), { force: true });
  }

  /** Stop with work still open: this copy's own file goes, its owner files
   *  stay. They then name a copy that is not there, so the copy that serves
   *  (or the next one started on this port) takes the accounts and continues
   *  what the stop cut. */
  forget() {
    if (!this.enabled) return;
    rmSync(this.copyPath(this.port), { force: true });
  }

  /** The other copies that are running now. */
  others(): CopyInfo[] {
    if (!this.enabled) return [];
    const out: CopyInfo[] = [];
    for (const name of readdirSync(this.dir)) {
      const m = /^copy-(\d+)\.json$/.exec(name);
      if (!m || Number(m[1]) === this.port) continue;
      const info = this.read(Number(m[1]));
      // a dead copy's file is left alone: removing it here could race a new
      // copy starting on that port (the rollout and the copy itself clean up)
      if (info && this.alive(info.pid)) out.push(info);
    }
    return out;
  }

  /** The port of the live copy that owns the account, or null for nobody.
   *  An owner file a dead copy left, or an earlier lifetime of a port, is not
   *  an owner. */
  ownerOf(account: string): number | null {
    if (!this.enabled) return this.port;
    const owner = this.readOwner(account);
    if (!owner) return null;
    if (owner.port === this.port) return owner.startedAt === this.startedAt ? this.port : null;
    const info = this.read(owner.port);
    // a file without a lifetime (another build's way of writing it) is still
    // that port's while a copy runs there: when unsure, never take a busy account
    return info && (owner.startedAt === 0 || info.startedAt === owner.startedAt) && this.alive(info.pid) ? owner.port : null;
  }

  /** Take the account if nobody live has it. Returns the owner's port: this
   *  copy's when the claim held, another's when that copy has it. A retiring
   *  copy takes nothing new: it returns null for an account it does not
   *  already own. One copy at a time decides (the lock), so two copies that
   *  find the same account free cannot both take it. */
  claim(account: string): number | null {
    if (!this.enabled) return this.port;
    const fast = this.ownerOf(account);
    if (fast !== null) return fast;
    if (this.retiringNow) return null;
    return this.locked(() => {
      const owner = this.ownerOf(account);
      if (owner !== null) return owner;
      const path = this.ownerPath(account);
      const tmp = `${path}.${this.pid}.tmp`;
      writeFileSync(tmp, `${this.port} ${this.startedAt}`, { mode: 0o600 });
      renameSync(tmp, path);
      return this.port;
    });
  }

  /** Give the account up (only this copy's own claim is removed). */
  release(account: string) {
    if (!this.enabled) return;
    if (this.ownerOf(account) === this.port) rmSync(this.ownerPath(account), { force: true });
  }

  /** The accounts this copy holds. */
  owned(): string[] {
    if (!this.enabled) return [];
    return this.owners().filter((account) => this.ownerOf(account) === this.port);
  }

  /** Accounts whose owner file names a copy that is gone. */
  orphaned(): string[] {
    if (!this.enabled) return [];
    return this.owners().filter((account) => this.ownerOf(account) === null);
  }

  /** Every account with an owner file, whoever it names. */
  private owners(): string[] {
    const out: string[] = [];
    for (const name of readdirSync(this.dir)) {
      const m = OWNER.exec(name);
      if (m?.[1] && !name.endsWith('.tmp')) out.push(m[1]);
    }
    return out;
  }

  private readOwner(account: string): { port: number; startedAt: number } | null {
    try {
      const [port, startedAt] = readFileSync(this.ownerPath(account), 'utf8').trim().split(' ').map(Number);
      return port && Number.isInteger(port) && port > 0 ? { port, startedAt: startedAt || 0 } : null;
    } catch {
      return null;
    }
  }

  /** Run `fn` as the only copy deciding an owner. A lock a dead copy left
   *  (older than five seconds) is broken. */
  private locked<T>(fn: () => T): T {
    const lock = join(this.dir, 'claim.lock');
    const wait = new Int32Array(new SharedArrayBuffer(4));
    let held = false;
    // a decision takes well under a millisecond: a lock two seconds old was
    // left by a copy that died holding it, and it is broken long before the
    // three seconds this copy is willing to wait
    for (let tries = 0; tries < 600 && !held; tries++) {
      try {
        mkdirSync(lock);
        held = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          if (Date.now() - statSync(lock).mtimeMs > 2000) rmSync(lock, { recursive: true, force: true });
        } catch {
          // gone already
        }
        Atomics.wait(wait, 0, 0, 5);
      }
    }
    if (!held) throw new Error('could not decide who holds the account: the claim lock stayed taken');
    try {
      return fn();
    } finally {
      rmSync(lock, { recursive: true, force: true });
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
