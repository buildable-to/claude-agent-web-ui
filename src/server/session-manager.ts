import {
  deleteSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  renameSession,
  type PermissionMode,
  type SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineInfo, HistoryMessage, SessionSummary } from '../shared/protocol.js';
import { redactHistory } from './redact.js';
import { claudeConfigDir, installedSkills, probeEngine, skillCommands } from './commands.js';
import { LiveSession, engineEnv, type LiveSessionOptions } from './live-session.js';
import { RunLog, doorSender, type Conversation, type Sender } from './run-log.js';
import { sharedLogins } from './logins.js';
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
/** The model the engineer picked for a conversation. The engine forgets it
 *  when it stops (a deploy, a login switch, an idle hour), and the
 *  conversation would come back on the default: "it changed by itself". */
const MODELS_FILE = '.agent-models.json';
/** A library conversation's element, by conversation id (ezdxf-flask #723). */
const SUBJECTS_FILE = '.agent-subjects.json';
/** What a subject may be: an element id, or `draft:<id>`. */
export const SUBJECT_RE = /^(draft:)?[A-Za-z0-9_-]{1,64}$/;
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
  // a project page reaches its own project's conversations only (security
  // review 2026-11-08); an older untagged one may still be opened here
  if (where.project && tag && tag !== where.project) {
    return 'That conversation is about another project; open it from that project.';
  }
  return null;
}
/** What each conversation has cost so far (the engine's running totals). */
const USAGE_FILE = '.agent-usage.json';

export type Usage = { totalCostUsd: number; numTurns: number; at: number };

/** Models and Buildable's own skills are the same for every folder seeded
 *  from one template under one home; probe the engine once per process, not
 *  once per account. An account's own skills (`<folder>/.claude/skills`,
 *  ezdxf-flask#807) are never in it: each account adds its own, read fresh. */
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
  private subjects: Record<string, string>;
  private models: Record<string, string>;
  private usage: Record<string, Usage>;
  private readonly work: WorkJournal;
  /** Each run's record for pricing, on the server only (ezdxf-flask #1227). */
  private readonly runs: RunLog | null;
  /** What each conversation opened in this lifetime is called, for its runs. */
  private readonly titles = new Map<string, string>();

  constructor(
    readonly projectDir: string,
    /** The app account this folder belongs to (multi-account mode). */
    readonly accountId?: string,
    shared?: SharedEngineInfo,
    private readonly dependencies: {
      queryFactory?: LiveSessionOptions['queryFactory'];
      getSessionInfo?: typeof getSessionInfo;
      getSessionMessages?: typeof getSessionMessages;
      sessionTimes?: typeof sessionTimes;
      rowsBeforeCompactions?: typeof rowsBeforeCompactions;
      /** Where run records go (tests); the app's door by default. */
      sendRun?: Sender;
      /** How long after a run its transcript is read (tests: 0). */
      runSettleMs?: number;
    } = {},
  ) {
    this.info = shared ?? { value: null, probe: null };
    this.projects = this.readJson<Record<string, string>>(PROJECTS_FILE);
    this.subjects = this.readJson<Record<string, string>>(SUBJECTS_FILE);
    this.models = this.readJson<Record<string, string>>(MODELS_FILE);
    this.usage = this.readJson<Record<string, Usage>>(USAGE_FILE);
    this.work = new WorkJournal(projectDir);
    this.runs = accountId
      ? new RunLog(
          projectDir,
          accountId,
          transcriptDir(projectDir),
          dependencies.sendRun ?? doorSender(engineEnv({ BUILDABLE_ACCOUNT: accountId })),
          (id) => this.conversation(id),
          dependencies.runSettleMs,
        )
      : null;
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
    // what the page picks now, else what was picked for this conversation before
    const model = opts.model ?? (sessionId ? this.models[sessionId] : undefined);
    const only = await this.offeredCommands();
    // On the server every engine runs on the Claude login the admin picked
    // (logins.ts); a laptop keeps its own.
    const login = this.accountId ? sharedLogins().current() : undefined;
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
      ...(model ? { model } : {}),
      onModel: (picked) => this.keepModel(session.sessionId, picked),
      ...(project ? { project } : {}),
      ...(library ? { scope: 'library' as const } : {}),
      ...(title ? { title } : {}),
      ...(only ? { onlyCommands: only } : {}),
      // On a shared server one click must not rewrite a folder's rules for good.
      persistAlways: !this.accountId,
      env: {
        ...(login?.env ?? {}),
        ...(this.accountId ? { BUILDABLE_ACCOUNT: this.accountId } : {}),
        ...(project ? { BUILDABLE_PROJECT: project } : {}),
      },
      onInfo: (info) => {
        void this.shareInfo(info);
      },
      onRateLimit: login ? (info) => sharedLogins().noteLimit(login.id, info) : undefined,
      onRunStart: (at) => this.runs?.begin(session.sessionId, at),
      onRun: (run) => this.runs?.end(session.sessionId, run),
      onResult: (u) => {
        this.usage[session.sessionId] = u;
        this.writeJson(USAGE_FILE, this.usage);
      },
    });
    this.live.set(session.sessionId, session);
    if (title) this.titles.set(session.sessionId, title);
    if (opts.model) this.keepModel(session.sessionId, opts.model);
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

  /** What every account may see of one engine's lists: in accounts mode only
   *  the home's skills, never the account's own (another account would be
   *  offered them). */
  private async shareInfo(info: EngineInfo): Promise<void> {
    if (!this.accountId) {
      this.info.value = info;
      return;
    }
    const home = await installedSkills([claudeConfigDir()]);
    this.info.value = { ...info, commands: info.commands.filter((c) => home.has(c.name)) };
  }

  /** Commands, skills and models for this project, from a live engine or a
   *  one-off probe; in accounts mode with the folder's own skills as they
   *  are on disk now, so a skill the engineer just wrote is offered. */
  async engineInfo(): Promise<EngineInfo> {
    const shared = await this.sharedInfo();
    if (!this.accountId) return shared;
    const seen = new Set(shared.commands.map((c) => c.name));
    const own = (await skillCommands([join(this.projectDir, '.claude')], true)).filter((c) => !seen.has(c.name));
    return { ...shared, commands: [...shared.commands, ...own].sort((a, b) => a.name.localeCompare(b.name)) };
  }

  private async sharedInfo(): Promise<EngineInfo> {
    if (this.info.value) return this.info.value;
    if (!this.info.probe) {
      this.info.probe = this.offeredCommands()
        .then((only) => probeEngine(this.projectDir, only, undefined, Boolean(this.accountId)))
        .then(async (info) => {
          await this.shareInfo(info);
          console.log(`[sessions] discovered ${info.commands.length} commands, ${info.models.length} models`);
          return this.info.value ?? info;
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
  /** Which element a library conversation is about — set by the element's
   *  page (a new chat there, or a draft's chat following it into the element
   *  it became). Library conversations only. */
  setSubject(sessionId: string, subject: string): string | null {
    if (!SUBJECT_RE.test(subject)) return 'not an element';
    const tag = this.projects[sessionId];
    const live = this.get(sessionId);
    if (tag !== LIBRARY_TAG && live?.scope !== 'library') return 'not a library conversation';
    if (this.subjects[sessionId] !== subject) {
      this.subjects[sessionId] = subject;
      this.writeJson(SUBJECTS_FILE, this.subjects);
    }
    return null;
  }

  async list(project?: string, scope?: 'library', subject?: string): Promise<SessionSummary[]> {
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
        ...(this.subjects[s.sessionId] ? { subject: this.subjects[s.sessionId] } : {}),
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
        ...(this.subjects[s.sessionId] ? { subject: this.subjects[s.sessionId] } : {}),
      });
    }
    rows.sort((a, b) => b.lastModified - a.lastModified);
    if (scope === 'library') {
      const lib = rows.filter((r) => r.scope === 'library');
      // an element's page lists that element's conversations alone
      return subject ? lib.filter((r) => r.subject === subject) : lib;
    }
    return project ? rows.filter((r) => r.project === project) : rows;
  }

  async history(sessionId: string): Promise<HistoryMessage[]> {
    const read = this.dependencies.getSessionMessages ?? getSessionMessages;
    const options = { dir: this.projectDir, includeSystemMessages: true };
    const latest = await read(sessionId, options);
    // The SDK's history starts at the last compaction; what was said before
    // each one is still in the file, and the engineer scrolls back for it.
    const messages: typeof latest = [];
    const seen = new Set(latest.map((m) => m.uuid));
    for (const rows of (this.dependencies.rowsBeforeCompactions ?? rowsBeforeCompactions)(this.projectDir, sessionId)) {
      const part = await read(sessionId, {
        ...options,
        sessionStore: { append: async () => {}, load: async () => rows as SessionStoreEntry[] },
      });
      for (const m of part) {
        if (seen.has(m.uuid)) continue;
        seen.add(m.uuid);
        messages.push(m);
      }
    }
    messages.push(...latest);
    const times = (this.dependencies.sessionTimes ?? sessionTimes)(this.projectDir, sessionId);
    const history: HistoryMessage[] = redactHistory(messages).map((m) => ({
      type: m.type,
      uuid: m.uuid,
      session_id: m.session_id,
      message: m.message,
      parent_tool_use_id: m.parent_tool_use_id,
      ...(times.has(m.uuid) ? { timestamp: times.get(m.uuid) } : {}),
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
    // deleting a conversation under a run stops it, as Stop would; its
    // tokens are counted before its transcript goes
    this.get(sessionId)?.close('user_stop');
    this.live.delete(sessionId);
    await this.runs?.settled();
    await deleteSession(sessionId, { dir: this.projectDir });
    this.work.remove(sessionId);
    if (sessionId in this.projects) {
      delete this.projects[sessionId];
      this.writeJson(PROJECTS_FILE, this.projects);
    }
    if (sessionId in this.subjects) {
      delete this.subjects[sessionId];
      this.writeJson(SUBJECTS_FILE, this.subjects);
    }
    this.keepModel(sessionId, null);
  }

  private keepModel(sessionId: string, model: string | null) {
    if ((this.models[sessionId] ?? null) === model) return;
    if (model) this.models[sessionId] = model;
    else delete this.models[sessionId];
    this.writeJson(MODELS_FILE, this.models);
  }

  /** What a run's record says of its conversation: its project (or the
   *  library), its title, and whether it is the first conversation about
   *  that project in this folder (the folder's tags keep their order). */
  private conversation(sessionId: string): Conversation {
    const tag = this.projects[sessionId];
    const first = tag !== undefined && Object.entries(this.projects).find(([, p]) => p === tag)?.[0] === sessionId;
    const title = this.titles.get(sessionId);
    return {
      project: tag && tag !== LIBRARY_TAG ? tag : null,
      scope: tag === LIBRARY_TAG ? 'library' : tag ? 'project' : null,
      ...(title ? { title } : {}),
      first,
    };
  }

  /** Runs this folder recorded in an earlier lifetime and could not send
   *  (or was cut in) go now (index.ts, at start). */
  runsSettled(): Promise<void> {
    return this.runs?.settled() ?? Promise.resolve();
  }

  /** Every live engine in this folder (for the usage view). */
  liveSessions(): LiveSession[] {
    return [...this.live.values()].filter((s) => s.status !== 'closed');
  }

  /** Engines with foreground or background work, including permission waits. */
  busy(): number {
    return this.pendingOpens + this.liveSessions().filter((s) => s.backgroundWork > 0 || s.status === 'running' || s.status === 'requires_action' || s.status === 'starting').length;
  }

  /** Close the engines doing nothing (no turn, no background work, no
   *  question waiting), so their next message starts on the login now
   *  active. A busy one keeps its login until its own turn ends. */
  closeIdle(): number {
    let n = 0;
    for (const [id, s] of this.live) {
      if (s.status === 'idle' && s.backgroundWork === 0 && s.pendingRequests.length === 0) {
        s.close('idle_timeout');
        this.live.delete(id);
        n++;
      }
    }
    return n;
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

/** Where the engine keeps a folder's conversations. */
export function transcriptDir(projectDir: string): string {
  return join(claudeConfigDir(), 'projects', projectDir.replace(/[^A-Za-z0-9]/g, '-'));
}

/** A saved conversation's lines up to each compaction, oldest first: one
 *  list per compaction, each holding everything written before it. Read as a
 *  conversation of its own, a list gives the stretch that ended there. Empty
 *  for a conversation that was never compacted. */
export function rowsBeforeCompactions(projectDir: string, sessionId: string): unknown[][] {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return [];
  let text: string;
  try {
    text = readFileSync(join(transcriptDir(projectDir), `${sessionId}.jsonl`), 'utf8');
  } catch {
    return [];
  }
  if (!text.includes('"compact_boundary"')) return [];
  const rows: unknown[] = [];
  const cuts: number[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as { type?: unknown; subtype?: unknown; isSidechain?: unknown };
      if (row.type === 'system' && row.subtype === 'compact_boundary' && !row.isSidechain && rows.length) cuts.push(rows.length);
      rows.push(row);
    } catch {
      // a torn last line while the engine writes
    }
  }
  return cuts.map((end) => rows.slice(0, end));
}

/** When each message of a saved conversation was said, by uuid. The SDK's
 *  history leaves the time out; the engine's own file has it on every line. */
export function sessionTimes(projectDir: string, sessionId: string): Map<string, string> {
  const times = new Map<string, string>();
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return times;
  const file = join(transcriptDir(projectDir), `${sessionId}.jsonl`);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return times;
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as { uuid?: unknown; timestamp?: unknown };
      if (typeof row.uuid === 'string' && typeof row.timestamp === 'string') times.set(row.uuid, row.timestamp);
    } catch {
      // a torn last line while the engine writes
    }
  }
  return times;
}
