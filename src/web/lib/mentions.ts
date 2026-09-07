// "@" in the composer: the project's marks and elements, offered as a list
// and dropped into the sentence as a pill. The list is POSTED IN by the page
// that embeds us (Project Studio holds the project; this screen never asks
// the app for it). A pill in a bubble, clicked, tells the studio to light
// the pieces up. What the agent gets is the plain text — "@C1" — and its
// standing note says how a tagged mark is read.

export type MentionMark = {
  mark: string;
  element: { id: string; name: string; kind: string };
  count: number;
  ids: string[];
};
export type MentionElement = { id: string; name: string; kind: string };
export type Mentions = { project: string | null; marks: MentionMark[]; library: MentionElement[] };

export const EMPTY_MENTIONS: Mentions = { project: null, marks: [], library: [] };

/** One row of the picker. `insert` is what lands after the "@" — the mark
 *  itself, or an element's id (names have spaces; the door reads ids). */
export type MentionItem = {
  key: string;
  label: string;
  hint: string;
  insert: string;
  kind: 'mark' | 'element';
};

/** Natural order for marks: letters, then the number (C2 before C10). */
function markKey(mark: string): [string, number, string] {
  const m = /^([A-Za-z]*)(\d*)(.*)$/.exec(mark) ?? [];
  return [m[1] ?? '', Number(m[2] ?? '') || 0, m[3] ?? ''];
}

export function compareMarks(a: string, b: string): number {
  const [la, na, ra] = markKey(a);
  const [lb, nb, rb] = markKey(b);
  return la.localeCompare(lb) || na - nb || ra.localeCompare(rb);
}

export function mentionItems(m: Mentions): MentionItem[] {
  const marks = [...m.marks]
    .sort((a, b) => compareMarks(a.mark, b.mark))
    .map<MentionItem>((x) => ({
      key: `mark:${x.mark}`,
      label: x.mark,
      hint: `${x.element.name || x.element.kind || 'element'} · ${x.count} piece${x.count === 1 ? '' : 's'}`,
      insert: x.mark,
      kind: 'mark',
    }));
  const library = [...m.library]
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
    .map<MentionItem>((e) => ({
      key: `element:${e.id}`,
      label: e.name || e.id,
      hint: `${e.kind || 'element'} · in the library, not placed`,
      insert: e.id,
      kind: 'element',
    }));
  return [...marks, ...library];
}

export function matchMentions(items: MentionItem[], query: string): MentionItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const label = (i: MentionItem) => i.label.toLowerCase();
  const starts = items.filter((i) => label(i).startsWith(q));
  const inLabel = items.filter((i) => !label(i).startsWith(q) && label(i).includes(q));
  const inHint = q.length >= 2 ? items.filter((i) => !label(i).includes(q) && i.hint.toLowerCase().includes(q)) : [];
  return [...starts, ...inLabel, ...inHint];
}

/** The "@word" being typed at the caret — its start and the word so far —
 *  or null when the caret is not inside one. */
export function mentionQuery(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, Math.max(0, Math.min(caret, value.length)));
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  const query = m[1] ?? '';
  return { start: before.length - query.length - 1, query };
}

/** Replace the "@word" at the caret with "@<insert> " and say where the caret lands. */
export function insertMention(
  value: string,
  caret: number,
  at: { start: number },
  insert: string,
): { value: string; caret: number } {
  const head = value.slice(0, at.start);
  const tail = value.slice(caret).replace(/^\s/, '');
  const text = `${head}@${insert} `;
  return { value: text + tail, caret: text.length };
}

const TOKEN = /@([A-Za-z0-9_.-]+)/g;

/** A sentence split into words and mentions, for the engineer's bubble. */
export function splitMentions(text: string): Array<string | { mention: string }> {
  const out: Array<string | { mention: string }> = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    out.push({ mention: m[1] ?? '' });
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The pill's face: a mark as itself, an element id as the element's name. */
export function mentionLabel(token: string, m: Mentions): { label: string; title: string; mark: string | null } {
  const mark = m.marks.find((x) => x.mark.toLowerCase() === token.toLowerCase());
  if (mark) {
    return {
      label: mark.mark,
      title: `${mark.element.name || mark.element.kind} · ${mark.count} piece${mark.count === 1 ? '' : 's'} — click to light them up`,
      mark: mark.mark,
    };
  }
  const el = m.library.find((e) => e.id === token) ?? m.marks.find((x) => x.element.id === token)?.element;
  if (el) return { label: el.name || token, title: `${el.kind || 'element'} · in the library`, mark: null };
  return { label: token, title: token, mark: null };
}

/** Marks named in the agent's words become pills: an explicit "@C1" always,
 *  a bare mark only when the project has it (a whole word, not inside code). */
export function linkMarks(markdown: string, known: string[]): string {
  const marks = known.filter(Boolean).sort((a, b) => b.length - a.length);
  const escaped = marks.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // one pass: an "@word" anywhere, or a known mark as a whole word — so a
  // link this pass writes is never scanned again by a second one
  const both = new RegExp(
    `(^|[^\\w[\\]])@([A-Za-z0-9_.-]+)` +
      (escaped.length ? `|(^|[^\\w@/\\[\\]:-])(${escaped.join('|')})(?![\\w/-])` : ''),
    'g',
  );
  const fix = (s: string) =>
    s.replace(both, (_m, pre1?: string, tok1?: string, pre2?: string, tok2?: string) => {
      const pre = tok1 !== undefined ? (pre1 ?? '') : (pre2 ?? '');
      const tok = tok1 ?? tok2 ?? '';
      return `${pre}[${tok}](mention:${tok})`;
    });
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      // inline code and existing links stay as they are
      return line
        .split(/(`[^`]*`|\[[^\]]*\]\([^)]*\))/)
        .map((part, i) => (i % 2 === 1 ? part : fix(part)))
        .join('');
    })
    .join('\n');
}
