// What the page was opened with. When Buildable embeds this UI in Project
// Studio it passes a signed token (who you are + which project), the project
// id, and embed=1 on the iframe URL; Element Studio passes `scope=library`
// and an empty `project=` instead. Standalone use has none of these.

import { readParam, readScope, type Store } from '@/lib/scope';
import { readAsk } from '@/lib/ask';

/** The tab's own storage, or null in a window that refuses it. */
export function tabStore(): Store | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}
const session = tabStore;

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
  /** `?fresh=1`: the page is one element's (Element Studio) — open a new
   *  chat unless the link names one, never the account's latest, which may be
   *  another element's still working (ezdxf-flask #723). */
  fresh: new URLSearchParams(location.search).get('fresh') === '1',
  /** `?subject=<element id | draft:<id>>`: the element's page — its chat list
   *  holds that element's conversations alone (ezdxf-flask #723). */
  subject: (() => {
    const s = new URLSearchParams(location.search).get('subject');
    return s && /^(draft:)?[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
  })(),
  /** `?ask=<words>`: the request typed before the project existed
   *  (ezdxf-flask #809) — sent once as a new chat's first message. Never
   *  with a conversation named. */
  ask: readAsk(location.search),
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
