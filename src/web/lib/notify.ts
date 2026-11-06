// What the studio is told when the agent needs the engineer (ezdxf-flask
// #1203): the page around the chat shows the notification, this page only
// says what happened. Plain functions, tested in notify.test.ts.
import type { PermissionRequest } from '@shared/protocol';
import type { Transcript } from './transcript';

/** The question a card asks, in one line: an AskUserQuestion's first
 *  question, else the engine's own sentence ("Claude wants to …"). */
export function questionText(pending: PermissionRequest[]): string | null {
  const p = pending[0];
  if (!p) return null;
  const qs = (p.input as { questions?: unknown }).questions;
  const first = Array.isArray(qs) ? (qs[0] as { question?: unknown } | undefined) : undefined;
  const said = typeof first?.question === 'string' ? first.question : p.title || p.description || `Allow ${p.toolName}?`;
  return said.replace(/\s+/g, ' ').trim() || null;
}

/** The turn just ended on an error: its note's words, else null. */
export function turnError(t: Transcript): string | null {
  const last = t.turns[t.turns.length - 1];
  return last && last.kind === 'note' && last.level === 'error' && !last.stoppedWork ? last.text : null;
}

const KEY = 'notify';

/** Notifications on unless the person turned them off with the bell (this browser). */
export function readNotifyOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeNotifyOn(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
}
