import {
  deleteSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  renameSession,
  type PermissionMode,
} from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineInfo, HistoryMessage, SessionSummary } from '../shared/protocol.js';
import { claudeConfigDir, installedSkills, probeEngine } from './commands.js';
import type { Scope } from './accounts.js';
import { LiveSession, type LiveSessionOptions } from './live-session.js';
import { WorkJournal } from './work-journal.js';

const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
/** How long a conversation with background work still running may go without
 *  a message before it is closed anyway — a guard against a task that never
 *  settles, never the normal way a long fan-out ends. */
const BACKGROUND_IDLE_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/** Whether the reaper closes this conversation now. A turn that ended with
 *  sub-agents still at work is NOT idle: closing it killed them (Maxima,
 *  2026-09-24: six gutter drafters stopped mid-work by "closing idle", and the
 *  page went on showing them running). */
export function shouldReap(
  s: { status: string; lastActivity: number; backgroundWork: number },
  now: number,
): boolean {
  if (s.status !== 'idle' && s.status !== 'closed') return false;
  const quiet = now - s.lastActivity;
  if (s.status === 'closed') return quiet > IDLE_TIMEOUT_MS;
  return quiet > (s.backgroundWork > 0 ? BACKGROUND_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS);
}
/** Which app project each conversation in this folder is about. */
const PROJECTS_FILE = '.agent-projects.json';
/** Which conversations belong to a panel that is not about a project (/stamp's).
 *  A file of its own, so a scope can never be mistaken for a project id. */
const SCOPES_FILE = '.agent-scopes.json';
/** What each conversation has cost so far (the engine's running totals). */
const USAGE_FILE = '.agent-usage.json';

/** The refusal for a conversation asked for from another panel. */
export const CROSS_PANEL = 'This conversation belongs to another panel';
/** The refusal while .agent-scopes.json cannot be read: no conversation's
 *  panel can be told, so none is listed or reopened on a panel (fail closed). */
export const TAGS_UNREADABLE =
  'This account\'s conversation tags are unreadable (.agent-scopes.json); an operator must repair it';

/** A refusal the HTTP routes answer with `status` (403 another panel, 503 tags unreadable). */
export class PanelError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type Usage = { totalCostUsd: number; numTurns: number; at: number };

/** Commands/models are the same for every folder seeded from one template
 *  under one home; probe the engine once per process, not once per account. */
/** Which conversations a panel lists: a project's (or, with no project, every
 *  conversation not in a scope), or a scope's alone. */
export type ListFilter = { project?: string } | { scope: Scope };

/** What a conversation's engine is told about the account and what it is for.
 *  A scoped conversation (/stamp) is about no project. */
export function sessionEnv(accountId: string | undefined, project: string | undefined, scope: Scope | undefined): Record<string, string> {
  return {
    ...(accountId ? { BUILDABLE_ACCOUNT: accountId } : {}),
    ...(scope ? { BUILDABLE_SCOPE: scope } : project ? { BUILDABLE_PROJECT: project } : {}),
  };
}

export type SharedEngineInfo = { value: EngineInfo | null; probe: Promise<EngineInfo> | null };

/** What a persisted conversation is called: the engineer's own name for it,
 *  else the engine's summary, else how it began. */
export function sessionTitle(s: { customTitle?: string; summary?: string; firstPrompt?: string }): string | undefined {
  return s.customTitle || s.summary || s.firstPrompt || undefined;
}

/** A fresh conversation is called by its first line until it has a better
 *  name — the same word the session list shows once the turn is on disk.
 *  The panel's own "Looking at …" line (the chip, web/lib/studio.ts
 *  LOOKING_AT) rides in front of the engineer's sentence and is not a name:
 *  found live, a lintel's chat was called "Looking at the whole project in 3D". */
export function titleFromPrompt(text: string | undefined, max = 120): string | undefined {
  const line = (text ?? '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find((l) => l && !/^Looking at /.test(l));
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export class SessionManager {
  private readonly live = new Map<string, LiveSession>();
  private readonly opening = new Map<string, Promise<LiveSession>>();
  private pendingOpens = 0;
  private readonly info: SharedEngineInfo;
  private projects: Record<string, string>;
  /** null: the file exists but cannot be read. Nothing is then known to be
   *  outside a scope, so every check that needs a tag refuses (checkPanel). */
  private scopes: Record<string, Scope> | null;
  private usage: Record<string, Usage>;
  private readonly work: WorkJournal;

  constructor(
    readonly projectDir: string,
    /** The app account this folder belongs to (multi-account mode). */
    readonly accountId?: string,
    shared?: SharedEngineInfo,
    private readonly dependencies: {
      queryFactory?: LiveSessionOptions['queryFactory'];
      getSessionInfo?: typeof getSessionInfo;
      getSessionMessages?: typeof getSessionMessages;
      listSessions?: typeof listSessions;
      renameSession?: typeof renameSession;
      deleteSession?: typeof deleteSession;
    } = {},
  ) {
    this.info = shared ?? { value: null, probe: null };
    this.projects = this.readJson<Record<string, string>>(PROJECTS_FILE);
    this.scopes = this.readScopes();
    this.usage = this.readJson<Record<string, Usage>>(USAGE_FILE);
    this.work = new WorkJournal(projectDir);
    setInterval(() => this.reapIdle(), 5 * 60 * 1000).unref();
  }

  get(sessionId: string): LiveSession | undefined {
    const s = this.live.get(sessionId);
    if (s && s.status === 'closed') {
      this.live.delete(sessionId);
      return undefined;
    }
    return s;
  }

  /** THE panel check, for every session id a client hands in (socket and
   *  HTTP alike): the conversation must be the asking panel's. `scope` is the
   *  token's (undefined: a project's panel, or a panel with no project). A
   *  running engine is judged by what it runs with; any other by its tag.
   *  Throws PanelError. */
  checkPanel(sessionId: string, scope: Scope | undefined): void {
    const live = this.get(sessionId);
    const tag = live ? live.scope : this.tags()[sessionId];
    if (tag !== scope) throw new PanelError(CROSS_PANEL, 403);
  }

  /** The scope tags, or a refusal while they cannot be read. */
  private tags(): Record<string, Scope> {
    if (!this.scopes) throw new PanelError(TAGS_UNREADABLE, 503);
    return this.scopes;
  }

  /** Attach to a live session, resume a persisted one, or start fresh.
   *  `firstPrompt` is the message that starts a fresh conversation: its first
   *  line is the conversation's title until the engine has a better one. */
  async open(
    sessionId: string | null,
    opts: { model?: string; permissionMode?: PermissionMode; project?: string; scope?: Scope; firstPrompt?: string } = {},
  ): Promise<LiveSession> {
    if (sessionId) {
      const existing = this.get(sessionId);
      if (existing) {
        this.checkPanel(sessionId, opts.scope);
        return existing;
      }
      const pending = this.opening.get(sessionId);
      if (pending) {
        const session = await pending;
        this.checkPanel(sessionId, opts.scope);
        return session;
      }
    }
    this.pendingOpens++;
    const pending = this.openEngine(sessionId, opts);
    if (sessionId) this.opening.set(sessionId, pending);
    try {
      return await pending;
    } finally {
      this.pendingOpens--;
      if (sessionId) this.opening.delete(sessionId);
    }
  }

  private async openEngine(
    sessionId: string | null,
    opts: { model?: string; permissionMode?: PermissionMode; project?: string; scope?: Scope; firstPrompt?: string },
  ): Promise<LiveSession> {
    let title: string | undefined;
    if (sessionId) {
      const existing = this.get(sessionId);
      if (existing) {
        this.checkPanel(sessionId, opts.scope);
        return existing;
      }
      // Only this folder's own conversations resume here. The engine would
      // otherwise find the id in ANY folder under the shared home.
      const info = await (this.dependencies.getSessionInfo ?? getSessionInfo)(sessionId, { dir: this.projectDir });
      if (!info) throw new Error('No such conversation in this account');
      // A conversation stays on the panel it was started on: /stamp's never
      // resumes on a project's panel, nor a project's on /stamp.
      this.checkPanel(sessionId, opts.scope);
      title = sessionTitle(info);
    } else {
      // a stamp conversation must be tagged to stay on its panel
      if (opts.scope) this.tags();
      title = titleFromPrompt(opts.firstPrompt);
    }
    const scope = opts.scope;
    const project = scope ? undefined : (opts.project ?? (sessionId ? this.projects[sessionId] : undefined));
    const { project: _p, scope: _s, firstPrompt: _f, ...rest } = opts;
    const only = await this.offeredCommands();
    const session = new LiveSession({
      cwd: this.projectDir,
      queryFactory: this.dependencies.queryFactory,
      recovery: sessionId ? this.work.recovery(sessionId) : undefined,
      onStart: (state) => this.work.begin(state),
      onActivity: (state) => this.work.update(state),
      onStop: (state, reason) => this.work.stop(state, reason),
      ...(sessionId ? { resume: sessionId } : {}),
      // Engineers' default on the internal stage (ezdxf-flask#391): a
      // classifier judges the routine commands; the live apply and the memory
      // write still ask, the deny rules still deny.
      ...(this.accountId ? { permissionMode: 'auto' as const } : {}),
      ...rest,
      ...(project ? { project } : {}),
      ...(scope ? { scope } : {}),
      ...(title ? { title } : {}),
      ...(only ? { onlyCommands: only } : {}),
      // On a shared server one click must not rewrite a folder's rules for good.
      persistAlways: !this.accountId,
      env: sessionEnv(this.accountId, project, scope),
      onInfo: (info) => {
        this.info.value = info;
      },
      onResult: (u) => {
        this.usage[session.sessionId] = u;
        this.writeJson(USAGE_FILE, this.usage);
      },
    });
    this.live.set(session.sessionId, session);
    if (project && this.projects[session.sessionId] !== project) {
      this.projects[session.sessionId] = project;
      this.writeJson(PROJECTS_FILE, this.projects);
    }
    const tags = scope ? this.tags() : undefined;
    if (scope && tags && tags[session.sessionId] !== scope) {
      tags[session.sessionId] = scope;
      // Untagged on disk, it would read as a project's after a restart: refuse it.
      if (!this.writeJson(SCOPES_FILE, tags)) {
        delete tags[session.sessionId];
        session.close();
        this.live.delete(session.sessionId);
        throw new PanelError('This conversation could not be tagged for its panel; try again', 503);
      }
    }
    console.log(
      `[sessions] ${sessionId ? 'resumed' : 'started'} ${session.shortId} in ${this.projectDir}`,
    );
    return session;
  }

  /** In accounts mode the composer offers the skills installed for the
   *  agent (Buildable's own), not Claude Code's commands: the agent's Claude
   *  home (CLAUDE_CONFIG_DIR on a laptop, ~/.claude on the server) plus the
   *  folder's own. Single mode keeps everything the engine knows. */
  private async offeredCommands(): Promise<Set<string> | null> {
    if (!this.accountId) return null;
    return installedSkills([claudeConfigDir(), join(this.projectDir, '.claude')]);
  }

  /** Commands, skills and models for this project, from a live engine or a one-off probe. */
  async engineInfo(): Promise<EngineInfo> {
    if (this.info.value) return this.info.value;
    if (!this.info.probe) {
      this.info.probe = this.offeredCommands()
        .then((only) => probeEngine(this.projectDir, only))
        .then((info) => {
          this.info.value = info;
          console.log(`[sessions] discovered ${info.commands.length} commands, ${info.models.length} models`);
          return info;
        })
        .finally(() => {
          this.info.probe = null;
        });
    }
    return this.info.probe;
  }

  /** What a panel lists (see ListFilter); with no filter, every conversation
   *  in this folder (the usage view). A project or a scope reads just the
   *  tagged ids: no folder scan, no cap. */
  async list(filter?: ListFilter): Promise<SessionSummary[]> {
    const project = filter && 'project' in filter ? filter.project : undefined;
    const scope = filter && 'scope' in filter ? filter.scope : undefined;
    // a panel's list needs the scope tags; only the usage view (no filter) does without
    const scopes = filter ? this.tags() : (this.scopes ?? {});
    let persisted;
    if (project || scope) {
      const tags: Record<string, string> = scope ? scopes : this.projects;
      const ids = Object.entries(tags)
        .filter(([, t]) => t === (scope ?? project))
        .map(([id]) => id);
      const info = this.dependencies.getSessionInfo ?? getSessionInfo;
      const found = await Promise.all(ids.map((id) => info(id, { dir: this.projectDir })));
      persisted = found.filter((s): s is NonNullable<typeof s> => Boolean(s));
    } else {
      persisted = await (this.dependencies.listSessions ?? listSessions)({ dir: this.projectDir, limit: 200 });
    }
    const rows: SessionSummary[] = persisted.map((s) => {
      const live = this.get(s.sessionId);
      const tag = this.projects[s.sessionId];
      const u = this.usage[s.sessionId];
      return {
        sessionId: s.sessionId,
        title: sessionTitle(s) || 'Untitled session',
        lastModified: s.lastModified,
        createdAt: s.createdAt,
        cwd: s.cwd,
        gitBranch: s.gitBranch,
        live: Boolean(live),
        status: live?.status,
        ...(tag ? { project: tag } : {}),
        ...(u ? { costUsd: u.totalCostUsd, turns: u.numTurns } : {}),
      };
    });
    // A brand-new live session has nothing on disk until its first turn finishes.
    for (const s of this.live.values()) {
      if (s.status === 'closed') continue;
      if (rows.some((r) => r.sessionId === s.sessionId)) continue;
      rows.unshift({
        sessionId: s.sessionId,
        title: 'New session',
        lastModified: s.lastActivity,
        cwd: s.cwd,
        live: true,
        status: s.status,
        ...(s.project ? { project: s.project } : {}),
      });
    }
    rows.sort((a, b) => b.lastModified - a.lastModified);
    if (!filter) return rows;
    if (scope) return rows.filter((r) => scopes[r.sessionId] === scope);
    const unscoped = rows.filter((r) => !scopes[r.sessionId]);
    return project ? unscoped.filter((r) => r.project === project) : unscoped;
  }

  /** `panel`: the asking token's scope; see checkPanel. */
  async history(sessionId: string, panel: Scope | undefined): Promise<HistoryMessage[]> {
    this.checkPanel(sessionId, panel);
    const messages = await (this.dependencies.getSessionMessages ?? getSessionMessages)(sessionId, {
      dir: this.projectDir,
      includeSystemMessages: true,
    });
    const history: HistoryMessage[] = messages.map((m) => ({
      type: m.type,
      uuid: m.uuid,
      session_id: m.session_id,
      message: m.message,
      parent_tool_use_id: m.parent_tool_use_id,
    }));
    for (const notice of this.stoppedWork(sessionId)) {
      const line: HistoryMessage = {
        type: 'system', uuid: notice.id, session_id: sessionId,
        message: {}, parent_tool_use_id: null, stoppedWork: notice,
      };
      let anchor = history.findIndex((m) => m.uuid === notice.afterMessageUuid);
      if (anchor < 0) history.push(line);
      else {
        while (history[anchor + 1]?.stoppedWork?.afterMessageUuid === notice.afterMessageUuid) anchor++;
        history.splice(anchor + 1, 0, line);
      }
    }
    return history;
  }

  stoppedWork(sessionId: string) {
    return this.work.notices(sessionId);
  }

  async rename(sessionId: string, title: string, panel: Scope | undefined) {
    this.checkPanel(sessionId, panel);
    await (this.dependencies.renameSession ?? renameSession)(sessionId, title, { dir: this.projectDir });
  }

  async remove(sessionId: string, panel: Scope | undefined) {
    this.checkPanel(sessionId, panel);
    this.get(sessionId)?.close();
    this.live.delete(sessionId);
    await (this.dependencies.deleteSession ?? deleteSession)(sessionId, { dir: this.projectDir });
    this.work.remove(sessionId);
    if (sessionId in this.projects) {
      delete this.projects[sessionId];
      this.writeJson(PROJECTS_FILE, this.projects);
    }
    if (this.scopes && sessionId in this.scopes) {
      delete this.scopes[sessionId];
      this.writeJson(SCOPES_FILE, this.scopes);
    }
  }

  /** Every live engine in this folder (for the usage view). */
  liveSessions(): LiveSession[] {
    return [...this.live.values()].filter((s) => s.status !== 'closed');
  }

  /** Engines with foreground or background work, including permission waits. */
  busy(): number {
    return this.pendingOpens + this.liveSessions().filter((s) => s.backgroundWork > 0 || s.status === 'running' || s.status === 'requires_action' || s.status === 'starting').length;
  }

  /** Record the stop before teardown; interrupt alone may leave builders alive. */
  async stop(sessionId: string): Promise<boolean> {
    const s = this.get(sessionId);
    if (!s) return false;
    s.close('user_stop');
    this.live.delete(sessionId);
    return true;
  }

  /** The scope tags. Unlike the other files, an unreadable one is not set
   *  aside for an empty one: with no tags every stamp conversation would read
   *  as a project's. It stays for an operator, and the panels refuse (null). */
  private readScopes(): Record<string, Scope> | null {
    const path = join(this.projectDir, SCOPES_FILE);
    if (!existsSync(path)) return {};
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
      return value as Record<string, Scope>;
    } catch (err) {
      console.error(`[sessions] SCOPE TAGS UNREADABLE: ${path}: ${String(err)}. No conversation is listed or reopened on a panel until it is repaired.`);
      return null;
    }
  }

  private readJson<T extends object>(name: string): T {
    const path = join(this.projectDir, name);
    if (!existsSync(path)) return {} as T;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch (err) {
      // keep the corrupt file for a human instead of silently wiping it
      try {
        renameSync(path, `${path}.corrupt-${Date.now()}`);
      } catch {
        // ignore
      }
      console.error(`[sessions] ${name} unreadable, set aside: ${String(err)}`);
      return {} as T;
    }
  }

  /** False (and logged) when the file could not be written. */
  private writeJson(name: string, value: object): boolean {
    const path = join(this.projectDir, name);
    try {
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
      renameSync(tmp, path);
      return true;
    } catch (err) {
      console.error(`[sessions] could not write ${name}: ${String(err)}`);
      return false;
    }
  }

  closeAll() {
    for (const s of this.live.values()) s.close();
    this.live.clear();
  }

  private reapIdle() {
    const now = Date.now();
    for (const [id, s] of this.live) {
      if (shouldReap(s, now)) {
        console.log(`[sessions] closing idle ${s.shortId}`);
        s.close('idle_timeout');
        this.live.delete(id);
      }
    }
  }
}
