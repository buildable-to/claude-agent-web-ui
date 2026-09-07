// What the page was opened with. When Buildable embeds this UI in Project
// Studio it passes a signed token (who you are + which project), the project
// id, and embed=1 on the iframe URL. Standalone use has none of these.

function read(name: string): string | null {
  const v = new URLSearchParams(location.search).get(name);
  if (v !== null) {
    try {
      sessionStorage.setItem(`page:${name}`, v);
    } catch {
      // ignore
    }
    return v;
  }
  try {
    return sessionStorage.getItem(`page:${name}`);
  } catch {
    return null;
  }
}

/** The path prefix this page is served under ('' or e.g. '/agent'). */
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export const page = {
  token: read('token'),
  project: read('project'),
  embed: read('embed') === '1',
  /** Dev mode only (server started with --dev-auth): which folder to use. */
  account: read('account'),
};

/** Headers every API call carries in multi-account mode. */
export function authHeaders(): Record<string, string> {
  return page.token ? { authorization: `Bearer ${page.token}` } : {};
}

/** Query string the server needs to know who is asking (dev mode's ?account=). */
export function authQuery(): string {
  if (page.token) return `token=${encodeURIComponent(page.token)}`;
  if (page.account) return `account=${encodeURIComponent(page.account)}`;
  return '';
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
