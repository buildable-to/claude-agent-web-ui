// What the page was opened with. When Buildable embeds this UI in Project
// Studio it passes a signed token (who you are + which project), the project
// id, and embed=1 on the iframe URL; Element Studio passes `scope=library`
// and an empty `project=` instead. Standalone use has none of these.

import { readParam, readScope, type Store } from '@/lib/scope';

function session(): Store | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

function read(name: string): string | null {
  return readParam(location.search, name, session());
}

const scoped = readScope(location.search, session());

/** The path prefix this page is served under ('' or e.g. '/agent'). */
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export const page = {
  token: read('token'),
  project: scoped.project,
  /** 'library' when opened from Element Studio: no project, ever. */
  scope: scoped.scope,
  embed: read('embed') === '1',
  /** The conversation the link names (`?conversation=<id>`), read from the
   *  URL alone — a link decides, never the tab's remembered past. */
  conversation: new URLSearchParams(location.search).get('conversation'),
  /** Dev mode only (server started with --dev-auth): which folder to use. */
  account: read('account'),
};

/** Headers every API call carries in multi-account mode. */
export function authHeaders(): Record<string, string> {
  return page.token ? { authorization: `Bearer ${page.token}` } : {};
}

/** Query string the server needs to know who is asking (dev mode's ?account=,
 *  and its ?scope= — with a token the scope is the token's, never the URL's). */
export function authQuery(): string {
  if (page.token) return `token=${encodeURIComponent(page.token)}`;
  if (page.account) return `account=${encodeURIComponent(page.account)}${devScope()}`;
  return '';
}

function devScope(): string {
  return page.scope ? `&scope=${page.scope}` : '';
}

/** Dev mode's account (and scope) for an API path; nothing with a token. */
export function withAccount(path: string): string {
  if (page.token || !page.account) return path;
  return `${path}${path.includes('?') ? '&' : '?'}account=${encodeURIComponent(page.account)}${devScope()}`;
}

/** The origin of the page that embeds us (Project Studio), or null when
 *  there is none. The referrer is that page (the default referrer policy
 *  keeps the origin across origins). Messages go only there, and only
 *  messages from there are heard. */
export function parentOrigin(): string | null {
  if (window.parent === window) return null;
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
}

/** Tell the page that embeds us (Project Studio) something happened. */
export function tellParent(message: Record<string, unknown>) {
  // Only the page that embedded us hears us — the messages carry what the
  // engineer typed; without a referrer, nobody is told.
  const target = parentOrigin();
  if (!target) return;
  window.parent.postMessage({ source: 'buildable-agent', ...message }, target);
}
