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
import { LiveSession } from './live-session.js';

const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
/** Which app project each conversation in this folder is about. */
const PROJECTS_FILE = '.agent-projects.json';
/** What each conversation has cost so far (the engine's running totals). */
const USAGE_FILE = '.agent-usage.json';

export type Usage = { totalCostUsd: number; numTurns: number; at: number };

/** Commands/models are the same for every folder seeded from one template
 *  under one home; probe the engine once per process, not once per account. */
export type SharedEngineInfo = { value: EngineInfo | null; probe: Promise<EngineInfo> | null };

export class SessionManager {
  private readonly live = new Map<string, LiveSession>();
  private readonly info: SharedEngineInfo;
  private projects: Record<string, string>;
  private usage: Record<string, Usage>;

  constructor(
    readonly projectDir: string,
    /** The app account this folder belongs to (multi-account mode). */
    readonly accountId?: string,
    shared?: SharedEngineInfo,
  ) {
    this.info = shared ?? { value: null, probe: null };
    this.projects = this.readJson<Record<string, string>>(PROJECTS_FILE);
    this.usage = this.readJson<Record<string, Usage>>(USAGE_FILE);
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

  /** Attach to a live session, resume a persisted one, or start fresh. */
  async open(
    sessionId: string | null,
    opts: { model?: string; permissionMode?: PermissionMode; project?: string } = {},
  ): Promise<LiveSession> {
    if (sessionId) {
      const existing = this.get(sessionId);
      if (existing) return existing;
      // Only this folder's own conversations resume here. The engine would
      // otherwise find the id in ANY folder under the shared home.
      const info = await getSessionInfo(sessionId, { dir: this.projectDir });
      if (!info) throw new Error('No such conversation in this account');
    }
    const project = opts.project ?? (sessionId ? this.projects[sessionId] : undefined);
    const { project: _p, ...rest } = opts;
    const only = await this.offeredCommands();
    const session = new LiveSession({
      cwd: this.projectDir,
      ...(sessionId ? { resume: sessionId } : {}),
      // Engineers' default on the internal stage (ezdxf-flask#391): a
      // classifier judges the routine commands; the live apply and the memory
      // write still ask, the deny rules still deny.
      ...(this.accountId ? { permissionMode: 'auto' as const } : {}),
      ...rest,
      ...(project ? { project } : {}),
      ...(only ? { onlyCommands: only } : {}),
      ...(project && process.env.BUILDABLE_URL
        ? { projectUrl: `${process.env.BUILDABLE_URL.replace(/\/$/, '')}/project-v4/sessions/${project}` }
        : {}),
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
    if (project && this.projects[session.sessionId] !== project) {
      this.projects[session.sessionId] = project;
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

  /** Every conversation in this folder, or only those about one app project.
   *  The project case reads just the tagged ids: no folder scan, no cap. */
  async list(project?: string): Promise<SessionSummary[]> {
    let persisted;
    if (project) {
      const ids = Object.entries(this.projects)
        .filter(([, p]) => p === project)
        .map(([id]) => id);
      const found = await Promise.all(ids.map((id) => getSessionInfo(id, { dir: this.projectDir })));
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
        title: s.customTitle || s.summary || s.firstPrompt || 'Untitled session',
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
    return project ? rows.filter((r) => r.project === project) : rows;
  }

  async history(sessionId: string): Promise<HistoryMessage[]> {
    const messages = await getSessionMessages(sessionId, {
      dir: this.projectDir,
      includeSystemMessages: true,
    });
    return messages.map((m) => ({
      type: m.type,
      uuid: m.uuid,
      session_id: m.session_id,
      message: m.message,
      parent_tool_use_id: m.parent_tool_use_id,
    }));
  }

  async rename(sessionId: string, title: string) {
    await renameSession(sessionId, title, { dir: this.projectDir });
  }

  async remove(sessionId: string) {
    this.get(sessionId)?.close();
    this.live.delete(sessionId);
    await deleteSession(sessionId, { dir: this.projectDir });
    if (sessionId in this.projects) {
      delete this.projects[sessionId];
      this.writeJson(PROJECTS_FILE, this.projects);
    }
  }

  /** Every live engine in this folder (for the usage view). */
  liveSessions(): LiveSession[] {
    return [...this.live.values()].filter((s) => s.status !== 'closed');
  }

  /** Engines in the middle of a turn, or waiting on the engineer. */
  busy(): number {
    return this.liveSessions().filter((s) => s.status === 'running' || s.status === 'requires_action' || s.status === 'starting').length;
  }

  /** Stop one conversation's engine: deny what it is waiting on, interrupt, close. */
  async stop(sessionId: string): Promise<boolean> {
    const s = this.get(sessionId);
    if (!s) return false;
    await s.interrupt().catch(() => undefined);
    s.close();
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
      const idle = s.status === 'idle' || s.status === 'closed';
      if (idle && now - s.lastActivity > IDLE_TIMEOUT_MS) {
        console.log(`[sessions] closing idle ${s.shortId}`);
        s.close();
        this.live.delete(id);
      }
    }
  }
}
