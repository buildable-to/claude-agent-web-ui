import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StoppedWorkNotice } from '../shared/protocol.js';

export type WorkState = {
  sessionId: string;
  generation: string;
  active: boolean;
  lastActiveAt: number;
  afterMessageUuid?: string;
};
type Entry = WorkState & { notices: StoppedWorkNotice[] };
type Journal = { version: 1; entries: Record<string, Entry> };

/** Per-account recovery state. Reading it never starts an engine. Writes
 *  replace the last good file atomically, before clients are told of changes. */
export class WorkJournal {
  private readonly path: string;
  private data: Journal;

  constructor(dir: string) {
    this.path = join(dir, '.agent-work.json');
    this.data = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, 'utf8')) as Journal
      : { version: 1, entries: {} };
    if (this.data.version !== 1 || !this.data.entries || typeof this.data.entries !== 'object') {
      throw new Error(`Unsupported recovery journal: ${this.path}`);
    }
    // A manager is created once per account in this server lifetime. An
    // active record left by its predecessor means the engine was lost.
    for (const entry of Object.values(this.data.entries)) {
      if (entry.active) this.stop(entry, 'service_restart');
    }
  }

  begin(state: WorkState) {
    this.save({ ...this.data.entries, [state.sessionId]: { ...state, notices: this.notices(state.sessionId) } });
  }

  update(state: WorkState) {
    const previous = this.data.entries[state.sessionId];
    if (!previous || previous.generation !== state.generation) return;
    this.save({ ...this.data.entries, [state.sessionId]: { ...previous, ...state } });
  }

  stop(state: WorkState, reason: StoppedWorkNotice['reason']): StoppedWorkNotice | undefined {
    const previous = this.data.entries[state.sessionId];
    if (!previous || previous.generation !== state.generation
      || (!previous.active && !state.active)
      || previous.notices.some((notice) => notice.id === state.generation)) return;
    const notice: StoppedWorkNotice = {
      id: state.generation,
      sessionId: state.sessionId,
      reason,
      detectedAt: Date.now(),
      lastActiveAt: state.lastActiveAt,
      ...(state.afterMessageUuid ? { afterMessageUuid: state.afterMessageUuid } : {}),
    };
    this.save({
      ...this.data.entries,
      [state.sessionId]: { ...previous, ...state, active: false, notices: [...previous.notices, notice] },
    });
    return notice;
  }

  notices(sessionId: string): StoppedWorkNotice[] {
    return this.data.entries[sessionId]?.notices ?? [];
  }

  recovery(sessionId: string): StoppedWorkNotice | undefined {
    const entry = this.data.entries[sessionId];
    const notice = entry?.notices.at(-1);
    return notice?.id === entry?.generation ? notice : undefined;
  }

  remove(sessionId: string) {
    const entries = { ...this.data.entries };
    delete entries[sessionId];
    this.save(entries);
  }

  private save(entries: Record<string, Entry>) {
    const data: Journal = { version: 1, entries };
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(data) + '\n');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.path);
      // File data alone does not make the rename survive a machine crash.
      // Flush its directory entry before acknowledging the durable change.
      const directory = openSync(dirname(this.path), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      this.data = data;
    } finally {
      rmSync(temp, { force: true });
    }
  }
}
