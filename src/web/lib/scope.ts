// Which project — or the element library — a page is about, read from its
// URL and the tab's memory. Kept apart from page.ts so it can be tested:
// page.ts reads location at import time.

export type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** A URL value, kept for the tab so a reload without it still knows. */
export function readParam(search: string, name: string, store: Store | null): string | null {
  const v = new URLSearchParams(search).get(name);
  if (v !== null) {
    try {
      store?.setItem(`page:${name}`, v);
    } catch {
      // ignore
    }
    return v;
  }
  try {
    return store?.getItem(`page:${name}`) ?? null;
  } catch {
    return null;
  }
}

/** The page's scope and project. The scope is read from the URL alone: one
 *  tab holds Project Studio and Element Studio frames side by side, and a
 *  remembered "library" must never turn a project frame into one. A library
 *  frame (or one whose URL says `project=` empty) never takes a project
 *  remembered from another frame: the panel would list that project's
 *  chats and send its id with the first message. */
export function readScope(search: string, store: Store | null): { scope: 'library' | null; project: string | null } {
  const params = new URLSearchParams(search);
  const library = params.get('scope') === 'library';
  if (library) return { scope: 'library', project: null };
  if (params.get('project') === '') return { scope: null, project: null };
  return { scope: null, project: readParam(search, 'project', store) };
}
