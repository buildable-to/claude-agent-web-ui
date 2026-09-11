// What the Project Studio page that embeds us says about ITSELF: what is on
// the engineer's screen right now. Everything you can look at over there is
// a named thing — a piece, a sheet, a page, a view — and the page posts one
// `viewing` record whenever that changes. This panel shows it as a chip
// above the composer and sends it in front of the next message, so "make
// this bigger" carries what "this" is.
//
// Kept apart from page.ts on purpose: page.ts reads location at import time,
// which a plain unit test has no business needing. The listening side is
// pinned to the embedder's origin, read off the referrer — the iframe is
// cross-origin on a laptop (:3456 beside :5000) and same-origin behind nginx
// on the box, so the origin is discovered, never assumed.

/** What is on the studio's screen. `text` is the chip ("E1 · Reinforcement ·
 *  page 1 of 4 · VIEW FROM A"); `line` is the sentence that rides in front
 *  of the next message ("Looking at E1 · Reinforcement · page 1 of 4 · VIEW
 *  FROM A [viewA]"). The fields say the same thing for a reader that wants
 *  fields; only the two strings are required. */
export type Viewing = {
  mode: '3d' | 'xray' | 'drawings' | 'element';
  text: string;
  line: string;
  mark?: string;
  element?: { id: string; name: string; kind: string };
  sheet?: { kind: string; label: string };
  page?: { n: number; of: number };
  view?: { key: string; caption: string; denom: number | null };
  ga?: { id: string; title: string };
  /** Every view the open sheet draws — what the agent's words can point at. */
  views?: StudioView[];
};

export type StudioView = { key: string; caption: string; denom: number | null };

/** The words the composer puts in front of the message, and the words the
 *  transcript folds back off it. One place, so the two cannot drift. */
export const LOOKING_AT = 'Looking at ';

/** Read a `viewing` record off the wire, or null if it is not one we trust
 *  to be well formed. A record with no words would print an empty chip and
 *  a bare "Looking at" in front of the engineer's sentence. */
export function readViewing(m: Record<string, unknown>): Viewing | null {
  if (m.type !== 'viewing') return null;
  const text = typeof m.text === 'string' ? m.text.trim() : '';
  const line = typeof m.line === 'string' ? m.line.trim() : '';
  if (!text || !line.startsWith(LOOKING_AT)) return null;
  const mode = m.mode === 'xray' || m.mode === 'drawings' || m.mode === 'element' ? m.mode : '3d';
  const out: Viewing = { mode, text, line };
  if (typeof m.mark === 'string' && m.mark) out.mark = m.mark;
  const e = m.element as Record<string, unknown> | undefined;
  if (e && typeof e === 'object') {
    out.element = {
      id: typeof e.id === 'string' ? e.id : '',
      name: typeof e.name === 'string' ? e.name : '',
      kind: typeof e.kind === 'string' ? e.kind : '',
    };
  }
  const s = m.sheet as Record<string, unknown> | undefined;
  if (s && typeof s === 'object' && typeof s.kind === 'string') {
    out.sheet = { kind: s.kind, label: typeof s.label === 'string' ? s.label : s.kind };
  }
  const p = m.page as Record<string, unknown> | undefined;
  if (p && typeof p === 'object' && typeof p.n === 'number' && typeof p.of === 'number') {
    out.page = { n: p.n, of: p.of };
  }
  const v = m.view as Record<string, unknown> | undefined;
  if (v && typeof v === 'object' && typeof v.key === 'string' && v.key) {
    out.view = {
      key: v.key,
      caption: typeof v.caption === 'string' && v.caption ? v.caption : v.key,
      denom: typeof v.denom === 'number' ? v.denom : null,
    };
  }
  const g = m.ga as Record<string, unknown> | undefined;
  if (g && typeof g === 'object' && typeof g.id === 'string' && g.id) {
    out.ga = { id: g.id, title: typeof g.title === 'string' ? g.title : '' };
  }
  if (Array.isArray(m.views)) {
    const views = (m.views as unknown[])
      .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : null))
      .filter((x): x is Record<string, unknown> => !!x && typeof x.key === 'string' && !!x.key)
      .map((x) => ({
        key: x.key as string,
        caption: typeof x.caption === 'string' && x.caption ? x.caption : (x.key as string),
        denom: typeof x.denom === 'number' ? x.denom : null,
      }));
    if (views.length) out.views = views;
  }
  return out;
}

/** Views the agent names become pills: a caption of the OPEN sheet ("VIEW
 *  FROM A", "Section B–B"), as a whole phrase outside code and existing
 *  links, case as printed on the paper. The href carries the view's key, the
 *  one thing the studio needs to frame it. Run AFTER linkMarks: a link that
 *  pass wrote is skipped here like any other. */
export function linkViews(markdown: string, views: StudioView[]): string {
  const caps = views.filter((v) => v.caption).sort((a, b) => b.caption.length - a.caption.length);
  if (!caps.length) return markdown;
  const keyOf = new Map(caps.map((v) => [v.caption, v.key]));
  const escaped = caps.map((v) => v.caption.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(^|[^\\w[\\]@/-])(${escaped.join('|')})(?![\\w/-])`, 'g');
  const fix = (s: string) =>
    s.replace(re, (_m, pre: string, cap: string) => `${pre}[${cap}](view:${keyOf.get(cap) ?? cap})`);
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line
        .split(/(`[^`]*`|\[[^\]]*\]\([^)]*\))/)
        .map((part, i) => (i % 2 === 1 ? part : fix(part)))
        .join('');
    })
    .join('\n');
}

/** The message as the engine gets it: the looking-at line first, then what
 *  the engineer typed. Context, never a command — the sentence beneath it
 *  says what to do. */
export function withViewing(text: string, viewing: Viewing | null): string {
  return viewing ? `${viewing.line}\n${text}` : text;
}

/** The transcript's view of a sent message: the looking-at line folded back
 *  off the top, so it can be shown as a small grey line above the bubble
 *  instead of as typed text. A message that never had one comes back whole. */
export function splitViewing(text: string): { viewing: string | null; text: string } {
  if (!text.startsWith(LOOKING_AT)) return { viewing: null, text };
  const nl = text.indexOf('\n');
  if (nl < 0) return { viewing: null, text };
  return { viewing: text.slice(0, nl), text: text.slice(nl + 1) };
}

/** Listen to the page that embeds us (Project Studio). Only the embedder is
 *  heard, judged by the referrer origin, and only messages that say who
 *  they are. Returns an unsubscribe. */
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

/** The transcript's grey line, read back: "Looking at E1 · Reinforcement ·
 *  page 1 of 4 · VIEW FROM A [viewA]" → the mark (first part), the sheet
 *  (second part, a label the studio resolves) and the view's key (the
 *  bracket at the end). A line about the whole project, or a GA sheet,
 *  names no piece and reads as null. */
export function parseLine(line: string): { mark: string; sheet: string | null; view: string | null } | null {
  const t = line.trim().replace(/^Looking at /, '');
  const km = /\s\[([^\]]+)\]$/.exec(t);
  const view = km?.[1] ?? null;
  const parts = (km ? t.slice(0, km.index) : t).split(' · ');
  const mark = parts[0]?.trim() ?? '';
  if (!mark || mark.startsWith('the ') || /^S-\d+$/.test(mark)) return null;
  const sheet = parts.length > 1 ? (parts[1] ?? '').trim() : '';
  return { mark, sheet: sheet || null, view };
}
