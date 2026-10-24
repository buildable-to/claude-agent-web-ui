// The request a stranger typed before their project existed (ezdxf-flask
// #809). The studio puts it in the panel's address once (`?ask=`); the panel
// sends it as the first message of a new chat, once. Kept apart from page.ts
// so it can be tested: page.ts reads location at import time.

import type { Store } from './scope';

export const ASK_CHARS = 4000;

/** The request in the address, or null. Read from the URL alone: a
 *  remembered one must never send again. Only the studio's own embed sends
 *  it — `embed=1`, the project and the signed token all in this same
 *  address — never a bare link that leans on a token the tab remembers
 *  (that link would run someone else's words in this account). A link
 *  that names a conversation opens that conversation and never sends. */
export function readAsk(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get('conversation')) return null;
  if (params.get('embed') !== '1' || !params.get('project') || !params.get('token')) return null;
  const v = (params.get('ask') ?? '').trim();
  return v ? v.slice(0, ASK_CHARS) : null;
}

/** The address without `ask=`, for history.replaceState: a reload of the
 *  panel alone must not send it again. */
export function withoutAsk(href: string): string {
  const u = new URL(href);
  u.searchParams.delete('ask');
  return u.toString();
}

function key(project: string | null, text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return `ask:${project ?? ''}:${(h >>> 0).toString(36)}`;
}

/** True the first time for these words on this project in this tab, false
 *  after: the second guard, behind the address losing `ask=`. */
export function firstAsk(text: string, project: string | null, store: Store | null): boolean {
  const k = key(project, text);
  try {
    if (store?.getItem(k)) return false;
    store?.setItem(k, '1');
  } catch {
    // a private window: the address guard alone
  }
  return true;
}
