// One running Claude Code engine process, driven through the Agent SDK.
// The browser talks to it through SessionManager + the WebSocket layer.

import { randomUUID } from 'node:crypto';
import {
  query,
  type CanUseTool,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  EngineInfo,
  Attachment,
  PermissionRequest,
  ServerMessage,
  SessionMeta,
  SessionStatus,
  StoppedWorkNotice,
} from '../shared/protocol.js';
import { toCommandInfo, toModelOptions } from './commands.js';
import { userContent } from './attachments.js';
import { SkillRedactor } from './redact.js';
import { forReplay, replaySince } from './replay.js';
import type { WorkState } from './work-journal.js';
import type { Outcome, RunEnd } from './run-log.js';

/** What an engine (and everything it runs) may see of the service's
 *  environment. The service's own secrets never cross this line.
 *  PYTHONSAFEPATH must cross it: without it `python -m` would put a chat's
 *  own folder ahead of the host's code (security review 2026-11-08). */
const ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TERM|TZ|TMPDIR|XDG_[A-Z_]+|NODE_OPTIONS|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|PYTHONPATH|PYTHONUNBUFFERED|PYTHONSAFEPATH|FREECAD_CMD|BUILDABLE_[A-Z_]+|AGENTS_ROOT|CLAUDE_[A-Z_]+|ANTHROPIC_[A-Z_]+)$/;

export function engineEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // the scope comes from a signed token, per conversation, never from the service
    if (v !== undefined && ENV_ALLOW.test(k) && k !== 'BUILDABLE_SCOPE') out[k] = v;
  }
  return { ...out, ...extra };
}

/** What a library conversation's engine is told and refused. The app's doors
 *  refuse project work under BUILDABLE_SCOPE=library; the engine is the second
 *  lock: the two project doors are denied outright, whatever the folder's
 *  allow rules say (deny beats allow). Rules in the style of the agent host's
 *  settings.shared.json. */
export const LIBRARY_DENIED_TOOLS: readonly string[] = ['perceive_project_v4', 'project_files_v4'].flatMap((door) =>
  ['python', 'python3'].flatMap((py) => [
    `Bash(${py} -m buildable.services.${door})`,
    `Bash(${py} -m buildable.services.${door} *)`,
  ]),
);

export function libraryEnv(env: Record<string, string>): Record<string, string> {
  const { BUILDABLE_PROJECT: _p, ...rest } = env;
  return { ...rest, BUILDABLE_SCOPE: 'library' };
}

export const LIBRARY_PROMPT =
  "The engineer is building their element library in Buildable's Element Studio; no project is open. " +
  'Work on library elements only — make, reinforce and draw elements; never create or change a project from this chat (the tools refuse). ' +
  "Learn where you stand with `python -m buildable.services.library_v4` (the library's drawings, the account's rules, its elements and drafts). ";

/** How the agent talks in the studio panel, project or library alike. */
const COLLEAGUE_TONE =
  'You are talking to a structural engineer inside their studio: call pieces by their marks and element names, not ids; ' +
  'name sheets by title; no revs, flags, command or tool names; never paste a link to the page they are on. ' +
  'End with what changed, what to look at, what to decide.';

/** The system prompt's append: where the engineer stands, how to talk, and
 *  a resume note after a stopped engine. Undefined when there is nothing to say. */
export function promptAppend(opts: { project?: string; scope?: 'library'; recovery?: unknown }): string | undefined {
  const where =
    opts.scope === 'library'
      ? LIBRARY_PROMPT + COLLEAGUE_TONE
      : opts.project
        ? `The engineer has project ${opts.project} open in Project Studio. ` +
          'Work in that project; do not create another one unless asked to in so many words. ' +
          COLLEAGUE_TONE
        : '';
  const resume = opts.recovery
    ? '\nThe previous engine stopped while work was in flight. The engineer has now chosen to resume. Before restarting builders, inspect the conversation and current project/file state, reconcile writes that already landed, and continue only unfinished work. Do not blindly repeat completed operations.'
    : '';
  return where || resume ? where + resume : undefined;
}

/** Which conversation the engine — and every door it runs — speaks for. The
 *  element doors stamp a draft or a saved element with it, so the project's
 *  Elements tab can say which chat made each row (ezdxf-flask #469). The id
 *  is always known here (a fresh one is minted before the engine starts);
 *  the title when the caller has one. */
export function conversationEnv(sessionId: string, title?: string): Record<string, string> {
  const t = (title ?? '').trim();
  return { BUILDABLE_CONVERSATION: sessionId, ...(t ? { BUILDABLE_CONVERSATION_TITLE: t } : {}) };
}

/** Push-based async iterable that feeds user turns into the engine. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(message: SDKUserMessage) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.items.push(message);
  }

  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

type Pending = {
  request: PermissionRequest;
  suggestions: PermissionUpdate[] | undefined;
  resolve: (result: PermissionResult) => void;
};

export type LiveSessionOptions = {
  cwd: string;
  /** Process boundary, injectable for lifecycle tests without launching Claude. */
  queryFactory?: typeof query;
  recovery?: StoppedWorkNotice;
  onStart?: (state: WorkState) => void;
  onActivity?: (state: WorkState) => void;
  onStop?: (state: WorkState, reason: StoppedWorkNotice['reason']) => StoppedWorkNotice | undefined;
  /** Called once the engine reports its slash commands, skills and models. */
  onInfo?: (info: EngineInfo) => void;
  /** Called after every turn with the running totals, for the usage record. */
  onResult?: (usage: { totalCostUsd: number; numTurns: number; at: number }) => void;
  /** A run began: the engineer's message, or a turn the engine started. */
  onRunStart?: (startedAt: number) => void;
  /** A run ended: the conversation is quiet again, or the engine stopped. */
  onRun?: (run: RunEnd) => void;
  /** The engine said where its Claude login stands against its limits. */
  onRateLimit?: (info: SDKRateLimitInfo) => void;
  /** Resume this persisted session. When omitted a fresh session is created. */
  resume?: string;
  model?: string;
  permissionMode?: PermissionMode;
  /** Extra environment for the engine and everything it runs. */
  env?: Record<string, string>;
  /** The app project this conversation is about. */
  project?: string;
  /** About the account's element library (Element Studio): no project, the
   *  project doors denied, BUILDABLE_SCOPE=library. Wins over `project`. */
  scope?: 'library';
  /** What this conversation is called, for the rows its elements make on the
   *  project's Elements tab (ezdxf-flask #469): "from “<title>”". */
  title?: string;
  /** Let "Always allow" write a rule to the folder's settings (default true; off on a shared server). */
  persistAlways?: boolean;
  /** Where the app shows the project, for the preface of the first message. */
  /** Offer only these slash commands in the composer (the installed skills on a shared server). */
  onlyCommands?: ReadonlySet<string>;
};

export type Subscriber = (message: ServerMessage) => void;

/** How bad an outcome is: a run's worst turn names it. */
const RUN_RANK: Record<Outcome, number> = { ok: 0, error: 1, restart: 2, stopped: 3 };

/** How a run ends when the engine stops under it, by the stop's reason. */
const RUN_CUT: Record<StoppedWorkNotice['reason'], Outcome | undefined> = {
  user_stop: 'stopped',
  service_stop: 'restart',
  service_restart: 'restart',
  engine_exit: 'error',
  // closed after hours without a word: background work that never settled;
  // its turns' own outcome stands, a run with none is an error
  idle_timeout: undefined,
};

export class LiveSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly project: string | undefined;
  readonly scope: 'library' | undefined;
  status: SessionStatus = 'starting';
  /** When the current turn began (running, or asking the engineer); null between turns. */
  private busySince: number | null = null;
  meta: SessionMeta = {};
  lastActivity = Date.now();
  /** Background tasks (sub-agents, backgrounded commands) the engine still
   *  runs, housekeeping excluded — the SDK's own level signal
   *  (`background_tasks_changed`). A conversation whose turn ended is still
   *  working while this is above zero. */
  backgroundWork = 0;
  /** The ids behind backgroundWork, so Stop can stop them. */
  private backgroundIds: string[] = [];

  private readonly input = new InputQueue();
  private readonly q: Query;
  private readonly abort = new AbortController();
  private readonly subscribers = new Set<Subscriber>();
  private readonly pending = new Map<string, Pending>();
  /** Everything the engine has emitted this process lifetime, minus stream
   *  events, as a page catching up needs it (replay.ts). */
  private readonly buffer: SDKMessage[] = [];
  /** what the agent reads of its skills never reaches a page (Buildable #1253) */
  private readonly skills = new SkillRedactor();
  private closed = false;
  private terminalOnlyCommands: string[] = [];
  private readonly onlyCommands: ReadonlySet<string> | null;
  private readonly onInfo: ((info: EngineInfo) => void) | undefined;
  private readonly onResult: LiveSessionOptions['onResult'];
  private readonly onRateLimit: LiveSessionOptions['onRateLimit'];
  /** tool_use ids of shell commands that write the app's project for real. */
  private readonly realApplies = new Set<string>();
  private perceives = new Map<string, PerceiveTarget>();
  private readonly persistAlways: boolean;
  private readonly generation = randomUUID();
  private lastMessageUuid: string | undefined;
  private readonly onActivity: LiveSessionOptions['onActivity'];
  private readonly onStop: LiveSessionOptions['onStop'];
  private readonly onRunStart: LiveSessionOptions['onRunStart'];
  private readonly onRun: LiveSessionOptions['onRun'];
  /** The run under way, from its first message until all is quiet again. */
  private run: { startedAt: number; outcome?: Outcome; error?: string; turns: number; modelUsage?: RunEnd['modelUsage']; stopping: boolean } | null = null;

  constructor(opts: LiveSessionOptions) {
    this.sessionId = opts.resume ?? randomUUID();
    this.cwd = opts.cwd;
    this.scope = opts.scope;
    this.project = this.scope === 'library' ? undefined : opts.project;
    this.persistAlways = opts.persistAlways ?? true;
    this.onInfo = opts.onInfo;
    this.onResult = opts.onResult;
    this.onRateLimit = opts.onRateLimit;
    this.onActivity = opts.onActivity;
    this.onStop = opts.onStop;
    this.onRunStart = opts.onRunStart;
    this.onRun = opts.onRun;
    this.onlyCommands = opts.onlyCommands ?? null;
    this.meta.permissionMode = opts.permissionMode ?? 'default';
    if (opts.model) this.meta.model = opts.model;

    const append = promptAppend({ project: this.project, scope: this.scope, recovery: opts.recovery });
    const library = (env: Record<string, string>) => (this.scope === 'library' ? libraryEnv(env) : env);
    opts.onStart?.(this.workState());
    try {
      this.q = (opts.queryFactory ?? query)({
        prompt: this.input,
        options: {
          cwd: this.cwd,
          ...(opts.resume ? { resume: opts.resume } : { sessionId: this.sessionId }),
          ...(opts.model ? { model: opts.model } : {}),
          // Use Claude Code's real system prompt (cwd, env, git status), not the SDK's bare default.
          // A conversation about an app project carries that in the system prompt,
          // where it neither breaks a leading slash command nor becomes the title.
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            // Context, not a brain: who reads the panel and how they talk.
            // No URL here: the agent used to paste it back at the engineer
            // who was already looking at the page.
            ...(append ? { append } : {}),
          },
          ...(this.scope === 'library' ? { disallowedTools: [...LIBRARY_DENIED_TOOLS] } : {}),
          permissionMode: opts.permissionMode ?? 'default',
          allowDangerouslySkipPermissions: opts.permissionMode === 'bypassPermissions',
          includePartialMessages: true,
          // Load the same settings the terminal would: user + project + local,
          // so CLAUDE.md files and existing allow rules apply here too.
          // On the shared server (no persisting), a desk's own settings.local.json
          // is not read: a chat can write that file, and it would outrank the
          // host's policy (security review 2026-11-08). A laptop keeps it.
          settingSources: this.persistAlways ? ['user', 'project', 'local'] : ['user', 'project'],
          canUseTool: this.canUseTool,
          abortController: this.abort,
          env: library(engineEnv({
            ...(opts.env ?? {}),
            ...conversationEnv(this.sessionId, opts.title),
            CLAUDE_AGENT_SDK_CLIENT_APP: 'claude-agent-web-ui/0.1.0',
            // Without it the engine never says when a turn starts or ends
            // (session_state_changed): a turn it starts by itself (a
            // sub-agent came back, a background command finished) ran with
            // the page, the studio and the deploy drain all reading idle.
            CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
          })),
          stderr: (data) => {
            const line = data.trim();
            if (line) console.error(`[engine ${this.shortId}] ${line}`);
          },
        },
      });
    } catch (err) {
      this.close('engine_exit');
      throw err;
    }
    void this.pump();
  }

  get shortId() {
    return this.sessionId.slice(0, 8);
  }

  get pendingRequests(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  /** What a page that already has `known` (its newest message uuids) lacks. */
  replay(known?: readonly string[]): SDKMessage[] {
    return replaySince(this.buffer, known);
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  send(text: string, uuid?: string, files: readonly Attachment[] = []) {
    if (this.closed) throw new Error('Session is closed');
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: userContent(this.cwd, text, files) },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid: (uuid ?? randomUUID()) as SDKUserMessage['uuid'],
      timestamp: new Date().toISOString(),
    };
    this.lastActivity = Date.now();
    this.lastMessageUuid = message.uuid;
    this.beginRun();
    try {
      // A queued turn can arrive while already running; persist it too.
      if (this.status === 'running') this.onActivity?.(this.workState());
      else this.setStatus('running');
    } catch (err) {
      this.close('engine_exit');
      throw err;
    }
    this.input.push(message);
  }

  answerPermission(
    requestId: string,
    behavior: 'allow' | 'deny',
    always = false,
    answers?: Record<string, string>,
  ): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    if (behavior === 'allow') {
      p.resolve({
        behavior: 'allow',
        // AskUserQuestion is answered through its own input: the chosen labels ride along.
        updatedInput: answers ? { ...p.request.input, answers } : p.request.input,
        ...(always && this.persistAlways && p.suggestions ? { updatedPermissions: p.suggestions } : {}),
      });
    } else {
      p.resolve({ behavior: 'deny', message: 'The user declined this action in the web UI.' });
    }
    this.broadcast({ type: 'permission_resolved', sessionId: this.sessionId, requestId });
    if (this.pending.size === 0 && this.status === 'requires_action') this.setStatus('running');
    return true;
  }

  async interrupt() {
    // Deny anything still waiting on the user, then stop the turn — and the
    // sub-agents and backgrounded commands it left running: the engineer has
    // one Stop, and it stops the work, not only the part in the foreground.
    if (this.run) this.run.stopping = true;
    for (const id of [...this.pending.keys()]) this.answerPermission(id, 'deny');
    const background = this.backgroundIds;
    if (this.status === 'running' || this.status === 'requires_action' || !background.length) await this.q.interrupt();
    await Promise.all(
      background.map((id) =>
        this.q.stopTask(id).catch((err: unknown) => {
          console.error(`[engine ${this.shortId}] stopTask ${id}: ${String(err)}`);
        }),
      ),
    );
  }

  async setPermissionMode(mode: PermissionMode) {
    await this.q.setPermissionMode(mode);
    this.meta = { ...this.meta, permissionMode: mode };
    this.broadcast({ type: 'meta', sessionId: this.sessionId, meta: this.meta });
  }

  async setModel(model: string | null) {
    await this.q.setModel(model ?? undefined);
    this.meta = { ...this.meta, model: model ?? undefined };
    this.broadcast({ type: 'meta', sessionId: this.sessionId, meta: this.meta });
  }

  close(reason: StoppedWorkNotice['reason'] = 'service_stop') {
    if (this.closed) return;
    try {
      const notice = this.onStop?.(this.workState(), reason);
      if (notice) this.broadcast({ type: 'work_stopped', sessionId: this.sessionId, notice });
    } catch (err) {
      console.error(`[engine ${this.shortId}] recovery write failed: ${String(err)}`);
      this.broadcast({ type: 'error', sessionId: this.sessionId, message: 'Could not save the interruption notice. Work has stopped; reopen this conversation before continuing.' });
    }
    this.endRun(RUN_CUT[reason]);
    this.closed = true;
    for (const id of [...this.pending.keys()]) this.answerPermission(id, 'deny');
    this.input.close();
    this.abort.abort();
    this.setStatus('closed');
  }

  // --- internals -----------------------------------------------------------

  private readonly canUseTool: CanUseTool = (toolName, input, opts) => {
    const request: PermissionRequest = {
      requestId: opts.requestId,
      toolUseId: opts.toolUseID,
      toolName,
      input,
      title: opts.title,
      description: opts.description,
      decisionReason: opts.decisionReason,
      blockedPath: opts.blockedPath,
      // no button for a promise the server will not keep
      canAlwaysAllow: this.persistAlways && Boolean(opts.suggestions?.length),
      createdAt: Date.now(),
    };
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(opts.requestId, { request, suggestions: opts.suggestions, resolve });
      this.setStatus('requires_action');
      this.broadcast({ type: 'permission_request', sessionId: this.sessionId, request });
      opts.signal.addEventListener('abort', () => {
        if (this.pending.delete(opts.requestId)) {
          resolve({ behavior: 'deny', message: 'Cancelled' });
          this.broadcast({
            type: 'permission_resolved',
            sessionId: this.sessionId,
            requestId: opts.requestId,
          });
          // the card is gone: "needs you" with nothing to answer is a lie
          if (this.pending.size === 0 && this.status === 'requires_action') this.setStatus('running');
        }
      });
    });
  };

  private async pump() {
    try {
      for await (const message of this.q) this.handle(message);
    } catch (err) {
      if (!this.closed) {
        const text = err instanceof Error ? err.message : String(err);
        console.error(`[engine ${this.shortId}] ${text}`);
        this.broadcast({ type: 'error', sessionId: this.sessionId, message: text });
      }
    } finally {
      this.close('engine_exit');
    }
  }

  private handle(raw: SDKMessage) {
    // when it arrived, so a page that attaches later shows the time it was
    // said, not the time it was replayed
    const message = stamped(raw);
    if (this.closed) return;
    this.lastActivity = Date.now();
    if (message.type === 'user' || message.type === 'assistant') {
      this.lastMessageUuid = message.uuid;
      // Persist the history boundary as well as membership changes. Stream
      // token deltas never write the journal.
      this.onActivity?.(this.workState());
    }
    if (message.type === 'system' && message.subtype === 'init') {
      this.meta = {
        ...this.meta,
        model: message.model,
        permissionMode: message.permissionMode,
        claudeCodeVersion: message.claude_code_version,
        tools: message.tools,
        // on the shared server the offered skills only: never one that is the agent's alone
        slashCommands: this.onlyCommands
          ? message.slash_commands.filter((n) => this.onlyCommands!.has(n.replace(/^\//, '')))
          : message.slash_commands,
      };
      this.terminalOnlyCommands = message.terminal_slash_commands ?? [];
      // The SDK sends an init at the start of EVERY turn, not only when the
      // engine comes up. Only the first one means "ready": on the others the
      // turn is running, and saying idle here told the page the agent was
      // done a tenth of a second after it started (seen 2026-09-07).
      if (this.status === 'starting') this.setStatus('idle');
      this.broadcast({ type: 'meta', sessionId: this.sessionId, meta: this.meta });
      void this.loadInitDetails();
    } else if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
      const work = message.tasks.filter((t) => !t.ambient);
      this.backgroundWork = work.length;
      this.backgroundIds = work.map((t) => t.task_id);
      this.onActivity?.(this.workState());
      this.endRunIfQuiet();
    } else if (message.type === 'system' && message.subtype === 'session_state_changed') {
      this.setStatus(message.state);
    } else if (message.type === 'system' && message.subtype === 'status' && message.permissionMode) {
      if (message.permissionMode !== this.meta.permissionMode) {
        this.meta = { ...this.meta, permissionMode: message.permissionMode };
        this.broadcast({ type: 'meta', sessionId: this.sessionId, meta: this.meta });
      }
    } else if (message.type === 'rate_limit_event') {
      this.onRateLimit?.(message.rate_limit_info);
    } else if (message.type === 'result') {
      this.meta = { ...this.meta, totalCostUsd: message.total_cost_usd };
      this.onResult?.({ totalCostUsd: message.total_cost_usd, numTurns: message.num_turns, at: Date.now() });
      this.noteResult(message);
      if (this.pending.size === 0) this.setStatus('idle');
      this.endRunIfQuiet();
    }
    const shown = this.skills.redact(message);
    if (shown && shown.type !== 'stream_event') this.buffer.push(forReplay(shown));
    if (shown) this.broadcast({ type: 'message', sessionId: this.sessionId, message: shown });
    this.watchRealApplies(message);
  }

  /** A `--real` apply is the one command that changes the app's project. When
   *  its result comes back, tell the page so it can redraw. And the element
   *  door names what the agent is looking at: `perceive_v4 <id>` — when its
   *  result comes back, tell the page so the Element tab can follow. */
  private watchRealApplies(message: SDKMessage) {
    if (message.type === 'assistant') {
      const content = message.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block.type !== 'tool_use' || block.name !== 'Bash') continue;
        const command = String((block.input as { command?: unknown }).command ?? '');
        if (/\s--real\b/.test(command)) this.realApplies.add(block.id);
        const target = perceiveTarget(command);
        if (target) this.perceives.set(block.id, target);
      }
    } else if (message.type === 'user') {
      const content = message.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (typeof block !== 'object' || block === null || block.type !== 'tool_result') continue;
        const id = String((block as { tool_use_id?: unknown }).tool_use_id ?? '');
        const failed = (block as { is_error?: unknown }).is_error === true;
        const target = this.perceives.get(id);
        if (target) {
          this.perceives.delete(id);
          // a refused read or save points nowhere
          if (!failed) {
            const focus = focusFromResult(target, resultText(block));
            this.broadcast({ type: 'element_focus', sessionId: this.sessionId, ...focus });
          }
        }
        if (!this.realApplies.delete(id)) continue;
        // a denied or failed apply changed nothing
        if (failed) continue;
        this.broadcast({
          type: 'project_changed',
          sessionId: this.sessionId,
          ...(this.project ? { project: this.project } : {}),
        });
      }
    }
  }

  private async loadInitDetails() {
    try {
      const init = await this.q.initializationResult();
      const commands = toCommandInfo(init.commands, this.terminalOnlyCommands, this.onlyCommands);
      const models = toModelOptions(init.models);
      this.meta = { ...this.meta, models, commands };
      this.broadcast({ type: 'meta', sessionId: this.sessionId, meta: this.meta });
      this.onInfo?.({ commands, models });
    } catch (err) {
      console.error(`[engine ${this.shortId}] initializationResult failed: ${String(err)}`);
    }
  }

  /** How long the current turn has run, so a page that attaches (or reloads)
   *  mid-turn shows the real time on it, not 0:00. Sent as a duration, not a
   *  timestamp: the page's clock need not agree with ours. */
  get busyForMs(): number | undefined {
    return this.busySince === null ? undefined : Date.now() - this.busySince;
  }

  private setStatus(status: SessionStatus) {
    if (this.status === status) return;
    if (this.status === 'closed') return;
    this.status = status;
    const busy = status === 'running' || status === 'requires_action';
    if (!busy) this.busySince = null;
    else if (this.busySince === null) this.busySince = Date.now();
    if (!this.closed) this.onActivity?.(this.workState());
    if (busy) this.beginRun();
    else if (status === 'idle') this.endRunIfQuiet();
    const busyForMs = this.busyForMs;
    this.broadcast({ type: 'status', sessionId: this.sessionId, status, ...(busyForMs !== undefined ? { busyForMs } : {}) });
  }

  // --- runs (ezdxf-flask #1227) ---------------------------------------------

  private beginRun() {
    if (this.run || this.closed) return;
    this.run = { startedAt: Date.now(), turns: 0, stopping: false };
    try {
      this.onRunStart?.(this.run.startedAt);
    } catch (err) {
      console.error(`[engine ${this.shortId}] run start not kept: ${String(err)}`);
    }
  }

  /** A turn's result: how it ended (the worst of the run's turns wins) and
   *  the engine's running totals. */
  private noteResult(message: Extract<SDKMessage, { type: 'result' }>) {
    this.beginRun();
    const run = this.run!;
    run.turns += message.num_turns;
    run.modelUsage = message.modelUsage;
    const failed = message.subtype !== 'success' || message.is_error;
    const outcome: Outcome = !failed ? 'ok' : run.stopping ? 'stopped' : 'error';
    if (RUN_RANK[outcome] >= RUN_RANK[run.outcome ?? 'ok']) run.outcome = outcome;
    if (failed && !run.error) {
      const text = message.subtype === 'success' ? message.result : [message.subtype, ...(message.errors ?? [])].join(': ');
      if (text) run.error = text;
    }
  }

  /** Quiet again — no turn, no sub-agent, no question waiting — ends the run. */
  private endRunIfQuiet() {
    if (!this.run || this.status !== 'idle' || this.backgroundWork > 0 || this.pending.size > 0) return;
    this.endRun();
  }

  /** `cut`: how the run ends when the engine stops under it. */
  private endRun(cut?: Outcome) {
    const run = this.run;
    if (!run) return;
    this.run = null;
    // a run whose own turns all ended may still be cut in its background
    // work; Stop on background work alone stops the run too
    let outcome: Outcome = run.outcome ?? 'error';
    if (run.stopping && RUN_RANK.stopped > RUN_RANK[outcome]) outcome = 'stopped';
    if (cut && (!run.outcome || RUN_RANK[cut] > RUN_RANK[outcome])) outcome = cut;
    try {
      this.onRun?.({
        startedAt: run.startedAt,
        endedAt: Date.now(),
        outcome,
        ...(run.error ? { error: run.error } : cut && outcome === cut ? { error: `the engine stopped (${cut})` } : {}),
        ...(run.turns ? { turns: run.turns } : {}),
        ...(run.modelUsage ? { modelUsage: run.modelUsage } : {}),
      });
    } catch (err) {
      console.error(`[engine ${this.shortId}] run not recorded: ${String(err)}`);
    }
  }

  private workState(): WorkState {
    return {
      sessionId: this.sessionId,
      generation: this.generation,
      active: this.backgroundWork > 0 || this.status === 'starting' || this.status === 'running' || this.status === 'requires_action',
      lastActiveAt: this.lastActivity,
      ...(this.lastMessageUuid ? { afterMessageUuid: this.lastMessageUuid } : {}),
    };
  }

  private broadcast(message: ServerMessage) {
    for (const fn of this.subscribers) {
      try {
        fn(message);
      } catch (err) {
        console.error('subscriber failed', err);
      }
    }
  }
}

/** What a `perceive_v4` command line names: the element or draft id in
 *  front of the flags, and whether it is the save door (`--save`, a draft). */
export type PerceiveTarget = { id: string; save: boolean };

export function perceiveTarget(command: string): PerceiveTarget | null {
  const m = /\bperceive_v4(?:\.py)?\s+(?!-)([A-Za-z0-9_-]{2,})(?=\s|$)/.exec(command);
  const id = m?.[1];
  if (!id) return null;
  return { id, save: /\s--save\b/.test(command) };
}

/** Where the Element tab should look once the door has answered: the saved
 *  element a `--save --real` produced ("SAVED as e9" / "UPDATED e4"), else
 *  the id the command named — a draft when it was the save door, otherwise
 *  the page decides (its library knows which ids are elements). */
export function focusFromResult(target: PerceiveTarget, text: string): { id: string; kind?: 'element' | 'draft' } {
  const saved = /\b(?:SAVED as|UPDATED) ([A-Za-z0-9_-]+)/.exec(text)?.[1];
  if (target.save && saved) return { id: saved, kind: 'element' };
  return target.save ? { id: target.id, kind: 'draft' } : { id: target.id };
}

function resultText(block: unknown): string {
  const content = (block as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
    .join('\n');
}

/** A said message (the engineer's or the agent's) carries when it was said. */
export function stamped(message: SDKMessage): SDKMessage {
  if (message.type !== 'user' && message.type !== 'assistant') return message;
  if (typeof (message as { timestamp?: unknown }).timestamp === 'string') return message;
  return { ...message, timestamp: new Date().toISOString() } as SDKMessage;
}
