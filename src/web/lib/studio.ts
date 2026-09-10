// The Project Studio protocol: what this page says to the Buildable page that
// embeds it, and what it hears back. Both directions are pinned to the
// embedder's origin, read off the referrer — the iframe is cross-origin on a
// laptop (:3456 beside :5000) and same-origin behind nginx on the box, so the
// origin is discovered, never assumed.
//
// Kept apart from page.ts on purpose: page.ts reads location at import time,
// which a plain unit test has no business needing.

/** Tell the page that embeds us (Project Studio) something happened. */
export function tellParent(message: Record<string, unknown>) {
  if (window.parent === window) return;
  // Only the page that embedded us hears us — the messages carry what the
  // engineer typed. The referrer is that page (the default referrer policy
  // keeps the origin across origins); without one, nobody is told.
  let target: string | null = null;
  try {
    target = document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    target = null;
  }
  if (!target) return;
  window.parent.postMessage({ source: 'buildable-agent', ...message }, target);
}

/** A piece the engineer picked in the studio: its mark, the library element it
 *  came from, and how many of it are placed. Sent as `type: 'mention'` when a
 *  piece is clicked in the 3D or the Elements panel. */
export type StudioTag = {
  mark: string;
  element: { id: string; name: string; kind: string };
  count: number;
  ids: string[];
};

/** Read a 'mention' message off the wire, or null if it is not one we trust to
 *  be well formed. The studio is same-origin-ish and friendly, but a tag that
 *  names nothing would put a bare "@" in front of the engineer's sentence. */
export function readTag(m: Record<string, unknown>): StudioTag | null {
  if (m.type !== 'mention' || typeof m.mark !== 'string' || !m.mark) return null;
  const e = (m.element ?? {}) as Record<string, unknown>;
  return {
    mark: m.mark,
    element: {
      id: typeof e.id === 'string' ? e.id : '',
      name: typeof e.name === 'string' ? e.name : '',
      kind: typeof e.kind === 'string' ? e.kind : '',
    },
    count: typeof m.count === 'number' ? m.count : 0,
    ids: Array.isArray(m.ids) ? m.ids.filter((x): x is string => typeof x === 'string') : [],
  };
}

/** Listen to the page that embeds us (Project Studio). Mirror of tellParent:
 *  only the embedder is heard, judged by the same referrer origin we speak to,
 *  and only messages that say who they are. Returns an unsubscribe. */
export function hearParent(handler: (message: Record<string, unknown>) => void): () => void {
  if (window.parent === window) return () => {};
  let origin: string | null = null;
  try {
    origin = document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    origin = null;
  }
  if (!origin) return () => {};
  const on = (e: MessageEvent) => {
    if (e.origin !== origin) return;
    const m = e.data as Record<string, unknown> | null;
    if (!m || m.source !== 'buildable-studio') return;
    handler(m);
  };
  window.addEventListener('message', on);
  return () => window.removeEventListener('message', on);
}
