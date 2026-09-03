// Wire protocol between the browser and the server.
// Both sides import from here; the SDK types are type-only so the browser
// bundle never pulls in the Node SDK.

import type { PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export type { PermissionMode, SDKMessage };

export type SessionStatus = 'starting' | 'idle' | 'running' | 'requires_action' | 'closed';

/** A permission question the engine is waiting on. */
export type PermissionRequest = {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Full prompt sentence from the engine, e.g. "Claude wants to read foo.txt". */
  title?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  /** True when the engine offered rules for "always allow". */
  canAlwaysAllow: boolean;
  createdAt: number;
};

export type ModelOption = { value: string; label: string; description?: string };

/** A slash command or skill the engine accepts in a message. */
export type CommandInfo = {
  name: string;
  description: string;
  argumentHint?: string;
};

export type SessionMeta = {
  model?: string;
  permissionMode?: PermissionMode;
  models?: ModelOption[];
  claudeCodeVersion?: string;
  tools?: string[];
  slashCommands?: string[];
  commands?: CommandInfo[];
  totalCostUsd?: number;
};

export type ClientMessage =
  /** Subscribe to a session that is already running. Answered with `attached` or `not_live`. */
  | { type: 'attach'; sessionId: string }
  | { type: 'detach'; sessionId: string }
  /** Start (null) or resume (id) an engine and send the first message in one go. */
  | { type: 'start'; sessionId: string | null; text: string; uuid?: string }
  | { type: 'send'; sessionId: string; text: string; uuid?: string }
  | {
      type: 'permission';
      sessionId: string;
      requestId: string;
      behavior: 'allow' | 'deny';
      always?: boolean;
    }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'set_permission_mode'; sessionId: string; mode: PermissionMode }
  | { type: 'set_model'; sessionId: string; model: string | null };

export type ServerMessage =
  | {
      type: 'attached';
      sessionId: string;
      cwd: string;
      status: SessionStatus;
      /** Messages the live process has produced so far (no stream events). */
      replay: SDKMessage[];
      pending: PermissionRequest[];
      meta: SessionMeta;
    }
  | { type: 'not_live'; sessionId: string }
  | { type: 'message'; sessionId: string; message: SDKMessage }
  | { type: 'permission_request'; sessionId: string; request: PermissionRequest }
  | { type: 'permission_resolved'; sessionId: string; requestId: string }
  | { type: 'status'; sessionId: string; status: SessionStatus }
  | { type: 'meta'; sessionId: string; meta: SessionMeta }
  | { type: 'error'; sessionId?: string; message: string };

/** One row in the session list. */
export type SessionSummary = {
  sessionId: string;
  title: string;
  lastModified: number;
  createdAt?: number;
  cwd?: string;
  gitBranch?: string;
  live: boolean;
  status?: SessionStatus;
};

/** Persisted transcript entry, as returned by GET /api/sessions/:id/messages. */
export type HistoryMessage = {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
};

export type ServerConfig = {
  projectDir: string;
  projectName: string;
  version: string;
};

/** Project folder listing for the files panel. */
export type TreeNode = {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
};

export type DirectoryTree = {
  root: string;
  files: number;
  dirs: number;
  truncated: boolean;
  tree: TreeNode;
};
