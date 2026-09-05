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
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  EngineInfo,
  PermissionRequest,
  ServerMessage,
  SessionMeta,
  SessionStatus,
} from '../shared/protocol.js';
import { toCommandInfo, toModelOptions } from './commands.js';

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
  /** Called once the engine reports its slash commands, skills and models. */
  onInfo?: (info: EngineInfo) => void;
  /** Resume this persisted session. When omitted a fresh session is created. */
  resume?: string;
  model?: string;
  permissionMode?: PermissionMode;
  /** Extra environment for the engine and everything it runs. */
  env?: Record<string, string>;
  /** The app project this conversation is about. */
  project?: string;
  /** Let "Always allow" write a rule to the folder's settings (default true; off on a shared server). */
  persistAlways?: boolean;
};

export type Subscriber = (message: ServerMessage) => void;

export class LiveSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly project: string | undefined;
  status: SessionStatus = 'starting';
  meta: SessionMeta = {};
  lastActivity = Date.now();

  private readonly input = new InputQueue();
  private readonly q: Query;
  private readonly abort = new AbortController();
  private readonly subscribers = new Set<Subscriber>();
  private readonly pending = new Map<string, Pending>();
  /** Everything the engine has emitted this process lifetime, minus stream events. */
  private readonly buffer: SDKMessage[] = [];
  private closed = false;
  private terminalOnlyCommands: string[] = [];
  private readonly onInfo: ((info: EngineInfo) => void) | undefined;
  /** tool_use ids of shell commands that write the app's project for real. */
  private readonly realApplies = new Set<string>();
  private readonly persistAlways: boolean;

  constructor(opts: LiveSessionOptions) {
    this.sessionId = opts.resume ?? randomUUID();
    this.cwd = opts.cwd;
    this.project = opts.project;
    this.persistAlways = opts.persistAlways ?? true;
    this.onInfo = opts.onInfo;
    this.meta.permissionMode = opts.permissionMode ?? 'default';
    if (opts.model) this.meta.model = opts.model;

    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.cwd,
        ...(opts.resume ? { resume: opts.resume } : { sessionId: this.sessionId }),
        ...(opts.model ? { model: opts.model } : {}),
        // Use Claude Code's real system prompt (cwd, env, git status), not the SDK's bare default.
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        permissionMode: opts.permissionMode ?? 'default',
        allowDangerouslySkipPermissions: opts.permissionMode === 'bypassPermissions',
        includePartialMessages: true,
        // Load the same settings the terminal would: user + project + local,
        // so CLAUDE.md files and existing allow rules apply here too.
        settingSources: ['user', 'project', 'local'],
        canUseTool: this.canUseTool,
        abortController: this.abort,
        env: {
          ...process.env,
          ...(opts.env ?? {}),
          CLAUDE_AGENT_SDK_CLIENT_APP: 'claude-agent-web-ui/0.1.0',
        },
        stderr: (data) => {
          const line = data.trim();
          if (line) console.error(`[engine ${this.shortId}] ${line}`);
        },
      },
    });
    void this.pump();
  }

  get shortId() {
    return this.sessionId.slice(0, 8);
  }

  get pendingRequests(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  get replay(): SDKMessage[] {
    return this.buffer;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  send(text: string, uuid?: string) {
    if (this.closed) throw new Error('Session is closed');
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid: (uuid ?? randomUUID()) as SDKUserMessage['uuid'],
      timestamp: new Date().toISOString(),
    };
    this.lastActivity = Date.now();
    this.input.push(message);
    this.setStatus('running');
  }

  answerPermission(requestId: string, behavior: 'allow' | 'deny', always = false): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    if (behavior === 'allow') {
      p.resolve({
        behavior: 'allow',
        updatedInput: p.request.input,
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
    // Deny anything still waiting on the user, then stop the turn.
    for (const id of [...this.pending.keys()]) this.answerPermission(id, 'deny');
    await this.q.interrupt();
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

  close() {
    if (this.closed) return;
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
      canAlwaysAllow: Boolean(opts.suggestions?.length),
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
      this.closed = true;
      this.input.close();
      this.setStatus('closed');
    }
  }

  private handle(message: SDKMessage) {
    this.lastActivity = Date.now();
    if (message.type === 'system' && message.subtype === 'init') {
      this.meta = {
        ...this.meta,
        model: message.model,
        permissionMode: message.permissionMode,
        claudeCodeVersion: message.claude_code_version,
        tools: message.tools,
        slashCommands: message.slash_commands,
      };
      this.terminalOnlyCommands = message.terminal_slash_commands ?? [];
      this.setStatus('idle');
      this.broadcast({ type: 'meta', sessionId: this.sessionId, meta: this.meta });
      void this.loadInitDetails();
    } else if (message.type === 'system' && message.subtype === 'session_state_changed') {
      this.setStatus(message.state);
    } else if (message.type === 'system' && message.subtype === 'status' && message.permissionMode) {
      if (message.permissionMode !== this.meta.permissionMode) {
        this.meta = { ...this.meta, permissionMode: message.permissionMode };
        this.broadcast({ type: 'meta', sessionId: this.sessionId, meta: this.meta });
      }
    } else if (message.type === 'result') {
      this.meta = { ...this.meta, totalCostUsd: message.total_cost_usd };
      if (this.pending.size === 0) this.setStatus('idle');
    }
    if (message.type !== 'stream_event') this.buffer.push(message);
    this.broadcast({ type: 'message', sessionId: this.sessionId, message });
    this.watchRealApplies(message);
  }

  /** A `--real` apply is the one command that changes the app's project. When
   *  its result comes back, tell the page so it can redraw. */
  private watchRealApplies(message: SDKMessage) {
    if (message.type === 'assistant') {
      const content = message.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block.type !== 'tool_use' || block.name !== 'Bash') continue;
        const command = String((block.input as { command?: unknown }).command ?? '');
        if (/\s--real(\s|$)/.test(command)) this.realApplies.add(block.id);
      }
    } else if (message.type === 'user') {
      const content = message.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (typeof block !== 'object' || block === null || block.type !== 'tool_result') continue;
        const id = String((block as { tool_use_id?: unknown }).tool_use_id ?? '');
        if (!this.realApplies.delete(id)) continue;
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
      const commands = toCommandInfo(init.commands, this.terminalOnlyCommands);
      const models = toModelOptions(init.models);
      this.meta = { ...this.meta, models, commands };
      this.broadcast({ type: 'meta', sessionId: this.sessionId, meta: this.meta });
      this.onInfo?.({ commands, models });
    } catch (err) {
      console.error(`[engine ${this.shortId}] initializationResult failed: ${String(err)}`);
    }
  }

  private setStatus(status: SessionStatus) {
    if (this.status === status) return;
    if (this.status === 'closed') return;
    this.status = status;
    this.broadcast({ type: 'status', sessionId: this.sessionId, status });
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
