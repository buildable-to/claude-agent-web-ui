import {
  deleteSession,
  getSessionMessages,
  listSessions,
  renameSession,
  type PermissionMode,
} from '@anthropic-ai/claude-agent-sdk';
import type { EngineInfo, HistoryMessage, SessionSummary } from '../shared/protocol.js';
import { probeEngine } from './commands.js';
import { LiveSession } from './live-session.js';

const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

export class SessionManager {
  private readonly live = new Map<string, LiveSession>();
  private infoCache: EngineInfo | null = null;
  private infoProbe: Promise<EngineInfo> | null = null;

  constructor(readonly projectDir: string) {
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
    opts: { model?: string; permissionMode?: PermissionMode } = {},
  ): Promise<LiveSession> {
    if (sessionId) {
      const existing = this.get(sessionId);
      if (existing) return existing;
    }
    const session = new LiveSession({
      cwd: this.projectDir,
      ...(sessionId ? { resume: sessionId } : {}),
      ...opts,
      onInfo: (info) => {
        this.infoCache = info;
      },
    });
    this.live.set(session.sessionId, session);
    console.log(
      `[sessions] ${sessionId ? 'resumed' : 'started'} ${session.shortId} in ${this.projectDir}`,
    );
    return session;
  }

  /** Commands, skills and models for this project, from a live engine or a one-off probe. */
  async engineInfo(): Promise<EngineInfo> {
    if (this.infoCache) return this.infoCache;
    if (!this.infoProbe) {
      this.infoProbe = probeEngine(this.projectDir)
        .then((info) => {
          this.infoCache = info;
          console.log(`[sessions] discovered ${info.commands.length} commands, ${info.models.length} models`);
          return info;
        })
        .finally(() => {
          this.infoProbe = null;
        });
    }
    return this.infoProbe;
  }

  async list(_project?: string): Promise<SessionSummary[]> {
    const persisted = await listSessions({ dir: this.projectDir, limit: 200 });
    const rows: SessionSummary[] = persisted.map((s) => {
      const live = this.get(s.sessionId);
      return {
        sessionId: s.sessionId,
        title: s.customTitle || s.summary || s.firstPrompt || 'Untitled session',
        lastModified: s.lastModified,
        createdAt: s.createdAt,
        cwd: s.cwd,
        gitBranch: s.gitBranch,
        live: Boolean(live),
        status: live?.status,
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
      });
    }
    rows.sort((a, b) => b.lastModified - a.lastModified);
    return rows;
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
