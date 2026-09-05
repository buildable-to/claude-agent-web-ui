// Accounts: one folder per Buildable account under AGENTS_ROOT, chosen from a
// signed token the app hands the page. The token is an HS256 JWT signed with
// the app's own secret (PyJWT-compatible): { sub: accountId, email?, sid?, exp }.
// Without AGENTS_ROOT the server runs exactly as before: one --dir, no auth.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { SessionManager, type SharedEngineInfo } from './session-manager.js';

export type Account = {
  /** Folder name and the app's user id. */
  id: string;
  email?: string;
  /** The project session the page was opened on, if any. */
  project?: string;
  dir: string;
};

export type AccountsConfig = {
  root: string;
  /** Empty = dev mode: `?account=<id>` picks the folder with no signature check. */
  authSecret: string;
  /** Per-account `.claude/settings.json` to seed a new folder with. */
  settingsTemplate?: string;
  /** Claude Code's own config file, where a folder is marked trusted. */
  claudeConfigPath: string;
};

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export type TokenClaims = { sub: string; email?: string; sid?: string; exp?: number; role?: string };

/** Verify an HS256 JWT and return its claims. Throws on any defect. */
export function verifyToken(token: string, secret: string): TokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('malformed token');
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string };
  let claims: TokenClaims;
  try {
    header = JSON.parse(fromB64url(h).toString('utf8')) as { alg?: string };
    claims = JSON.parse(fromB64url(p).toString('utf8')) as TokenClaims;
  } catch {
    throw new AuthError('malformed token');
  }
  if (header.alg !== 'HS256') throw new AuthError('unsupported token algorithm');
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = fromB64url(s);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new AuthError('bad token signature');
  }
  if (typeof claims.sub !== 'string' || !claims.sub) throw new AuthError('token has no subject');
  if (typeof claims.exp !== 'number') throw new AuthError('token has no expiry');
  if (claims.exp * 1000 < Date.now()) throw new AuthError('token expired');
  return claims;
}

/** Mint a token (tests and local tooling; the app mints the real ones). */
export function signToken(claims: TokenClaims, secret: string): string {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(claims));
  const s = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class Accounts {
  private readonly managers = new Map<string, SessionManager>();
  private readonly engineInfo: SharedEngineInfo = { value: null, probe: null };

  constructor(readonly config: AccountsConfig) {
    mkdirSync(config.root, { recursive: true });
    if (config.settingsTemplate && !existsSync(config.settingsTemplate)) {
      // Without the template a new folder would get no rules at all; better not to start.
      throw new Error(`account settings template not found: ${config.settingsTemplate}`);
    }
  }

  /** The account a request speaks for, from its token (or `?account=` in dev mode). */
  resolve(token: string | undefined, devAccount: string | undefined): Account {
    let claims: TokenClaims;
    if (this.config.authSecret) {
      if (!token) throw new AuthError('missing token');
      claims = verifyToken(token, this.config.authSecret);
    } else {
      if (!devAccount) throw new AuthError('no account (dev mode: pass ?account=<id>)');
      claims = { sub: devAccount };
    }
    if (!SAFE_ID.test(claims.sub)) throw new AuthError('bad account id');
    const dir = resolve(this.config.root, claims.sub);
    this.ensureDir(dir);
    if (claims.email) this.remember(dir, claims.sub, claims.email);
    return {
      id: claims.sub,
      ...(claims.email ? { email: claims.email } : {}),
      ...(claims.sid ? { project: claims.sid } : {}),
      dir,
    };
  }

  /** An admin token (role: 'admin', minted by the app for its admins) opens the usage view. */
  verifyAdmin(token: string | undefined): TokenClaims {
    if (!this.config.authSecret) throw new AuthError('no admin access in dev mode');
    if (!token) throw new AuthError('missing token');
    const claims = verifyToken(token, this.config.authSecret);
    if (claims.role !== 'admin') throw new AuthError('not an admin token');
    return claims;
  }

  /** Every account folder under the root, with what we know of the account. */
  listAccounts(): Account[] {
    return readdirSync(this.config.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && SAFE_ID.test(d.name))
      .map((d) => {
        const dir = resolve(this.config.root, d.name);
        let email: string | undefined;
        try {
          email = (JSON.parse(readFileSync(join(dir, '.account.json'), 'utf8')) as { email?: string }).email;
        } catch {
          // no record yet
        }
        return { id: d.name, ...(email ? { email } : {}), dir };
      });
  }

  manager(account: Account): SessionManager {
    let m = this.managers.get(account.dir);
    if (!m) {
      m = new SessionManager(account.dir, account.id, this.engineInfo);
      this.managers.set(account.dir, m);
    }
    return m;
  }

  closeAll() {
    for (const m of this.managers.values()) m.closeAll();
  }

  private readonly trusted = new Set<string>();
  private readonly remembered = new Set<string>();

  /** Keep the account's email beside its folder, for the usage view. */
  private remember(dir: string, id: string, email: string) {
    const key = `${dir}:${email}`;
    if (this.remembered.has(key)) return;
    try {
      writeFileSync(join(dir, '.account.json'), JSON.stringify({ id, email }, null, 2) + '\n');
      this.remembered.add(key);
    } catch {
      // cosmetic
    }
  }

  /** Make the folder on first use: `.claude/settings.json` from the template,
   *  `scratch/`, and the trust flag Claude Code needs before it honours the
   *  folder's own allow rules. The flag is checked on every first sight of a
   *  folder in this process, so a lost write is repaired next time. */
  private ensureDir(dir: string) {
    if (!existsSync(join(dir, '.claude', 'settings.json'))) {
      mkdirSync(join(dir, '.claude'), { recursive: true });
      mkdirSync(join(dir, 'scratch'), { recursive: true });
      if (this.config.settingsTemplate) {
        copyFileSync(this.config.settingsTemplate, join(dir, '.claude', 'settings.json'));
      } else {
        writeFileSync(join(dir, '.claude', 'settings.json'), '{}\n');
      }
      console.log(`[accounts] new folder ${basename(dir)} at ${dir}`);
    }
    if (this.trusted.has(dir)) return;
    try {
      const path = this.config.claudeConfigPath;
      const cfg = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
      const projects = (cfg.projects ?? {}) as Record<string, Record<string, unknown>>;
      if (projects[dir]?.hasTrustDialogAccepted !== true) {
        projects[dir] = { ...(projects[dir] ?? {}), hasTrustDialogAccepted: true };
        cfg.projects = projects;
        // atomic: the engines rewrite this file too; never leave it half-written
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
        renameSync(tmp, path);
      }
      this.trusted.add(dir);
    } catch (err) {
      console.error(`[accounts] could not mark ${dir} trusted (will retry): ${String(err)}`);
    }
  }
}

export class AuthError extends Error {
  readonly status = 401;
}

/** Claude Code's `.claude.json` (trust flags live there). Override with CLAUDE_JSON_PATH. */
export function defaultClaudeConfigPath(): string {
  return process.env.CLAUDE_JSON_PATH ?? join(homedir(), '.claude.json');
}
