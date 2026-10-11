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
/** Which app project each conversation in this folder is about — or
 *  LIBRARY_TAG for one started from Element Studio, about no project. */
const PROJECTS_FILE = '.agent-projects.json';
/** The tag of a library conversation. Never a project id (those are hex), so
 *  older code reading the file sees a project nobody opens. */
export const LIBRARY_TAG = '@library';

/** Where a page stands: the element library, a project, or neither (the
 *  standalone page). Decided by the token, never by what the page says. */
export type Scope = { library?: boolean; project?: string };

/** Why a conversation tagged `tag` may not be opened where the page stands,
 *  or null when it may. A library page opens only library conversations; a
 *  project page never opens one; the standalone page opens any. */
export function scopeRefusal(tag: string | undefined, where: Scope): string | null {
  if (where.library) {
    return tag === LIBRARY_TAG ? null : 'That conversation is about a project; it cannot be opened from the element library. Start a new one here.';
  }
  if (where.project && tag === LIBRARY_TAG) {
    return 'That conversation is about the element library; open it from Element Studio.';
  }
  return null;
}
/** What each conversation has cost so far (the engine's running totals). */
const USAGE_FILE = '.agent-usage.json';

export type Usage = { totalCostUsd: number; numTurns: number; at: number };

/** Commands/models are the same for every folder seeded from one template
 *  under one home; probe the engine once per process, not once per account. */
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
    } = {},
  ) {
    this.info = shared ?? { value: null, probe: null };
    this.projects = this.readJson<Record<string, string>>(PROJECTS_FILE);
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

  /** Why this conversation may not be opened where the page stands, or null. */
  refusal(sessionId: string, where: Scope): string | null {
    return scopeRefusal(this.projects[sessionId], where);
  }

  /** Attach to a live session, resume a persisted one, or start fresh.
   *  `firstPrompt` is the message that starts a fresh conversation: its first
   *  line is the conversation's title until the engine has a better one.
   *  `scope: 'library'` is a conversation about the element library: it
   *  resumes only library conversations, and never carries a project. */
  async open(
    sessionId: string | null,
    opts: { model?: string; permissionMode?: PermissionMode; project?: string; scope?: 'library'; firstPrompt?: string } = {},
  ): Promise<LiveSession> {
    if (sessionId) {
      const refused = this.refusal(sessionId, { library: opts.scope === 'library', project: opts.project });
      if (refused) throw new Error(refused);
      const existing = this.get(sessionId);
      if (existing) return existing;
      const pending = this.opening.get(sessionId);
      if (pending) return pending;
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
    opts: { model?: string; permissionMode?: PermissionMode; project?: string; scope?: 'library'; firstPrompt?: string },
  ): Promise<LiveSession> {
    let title: string | undefined;
    if (sessionId) {
      const existing = this.get(sessionId);
      if (existing) return existing;
      // Only this folder's own conversations resume here. The engine would
      // otherwise find the id in ANY folder under the shared home.
      const info = await (this.dependencies.getSessionInfo ?? getSessionInfo)(sessionId, { dir: this.projectDir });
      if (!info) throw new Error('No such conversation in this account');
      title = sessionTitle(info);
    } else {
      title = titleFromPrompt(opts.firstPrompt);
    }
    const tag = sessionId ? this.projects[sessionId] : undefined;
    // a library conversation resumed anywhere is still about the library
    const library = opts.scope === 'library' || tag === LIBRARY_TAG;
    const project = library ? undefined : (opts.project ?? tag);
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
      ...(library ? { scope: 'library' as const } : {}),
      ...(title ? { title } : {}),
      ...(only ? { onlyCommands: only } : {}),
      // On a shared server one click must not rewrite a folder's rules for good.
      persistAlways: !this.accountId,
      env: {
        ...(this.accountId ? { BUILDABLE_ACCOUNT: this.accountId } : {}),
        ...(project ? { BUILDABLE_PROJECT: project } : {}),
      },
      onInfo: (info) => {
        this.info.value = info;
      },
      onResult: (u) => {
        this.usage[session.sessionId] = u;
        this.writeJson(USAGE_FILE, this.usage);
      },
    });
    this.live.set(session.sessionId, session);
    const newTag = library ? LIBRARY_TAG : project;
    if (newTag && this.projects[session.sessionId] !== newTag) {
      this.projects[session.sessionId] = newTag;
      this.writeJson(PROJECTS_FILE, this.projects);
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

  /** Every conversation in this folder, or only those about one app project,
   *  or (`scope: 'library'`) only the element library's. The narrowed cases
   *  read just the tagged ids: no folder scan, no cap. */
  async list(project?: string, scope?: 'library'): Promise<SessionSummary[]> {
    let persisted;
    const want = scope === 'library' ? LIBRARY_TAG : project;
    if (want) {
      const ids = Object.entries(this.projects)
        .filter(([, p]) => p === want)
        .map(([id]) => id);
      const info = this.dependencies.getSessionInfo ?? getSessionInfo;
      const found = await Promise.all(ids.map((id) => info(id, { dir: this.projectDir })));
      persisted = found.filter((s): s is NonNullable<typeof s> => Boolean(s));
    } else {
      persisted = await listSessions({ dir: this.projectDir, limit: 200 });
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
        ...(tag === LIBRARY_TAG ? { scope: 'library' as const } : tag ? { project: tag } : {}),
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
        ...(s.scope ? { scope: s.scope } : {}),
      });
    }
    rows.sort((a, b) => b.lastModified - a.lastModified);
    if (scope === 'library') return rows.filter((r) => r.scope === 'library');
    return project ? rows.filter((r) => r.project === project) : rows;
  }

  async history(sessionId: string): Promise<HistoryMessage[]> {
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

  async rename(sessionId: string, title: string) {
    await renameSession(sessionId, title, { dir: this.projectDir });
  }

  async remove(sessionId: string) {
    this.get(sessionId)?.close();
    this.live.delete(sessionId);
    await deleteSession(sessionId, { dir: this.projectDir });
    this.work.remove(sessionId);
    if (sessionId in this.projects) {
      delete this.projects[sessionId];
      this.writeJson(PROJECTS_FILE, this.projects);
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

  private writeJson(name: string, value: object) {
    const path = join(this.projectDir, name);
    try {
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
      renameSync(tmp, path);
    } catch (err) {
      console.error(`[sessions] could not write ${name}: ${String(err)}`);
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
