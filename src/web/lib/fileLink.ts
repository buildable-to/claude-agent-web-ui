// A link to a file in the studio's folder ("Files"), written by the agent in
// a reply: `[Estimate.xlsx](https://app…/project-v4/sessions/<id>/files/<file>)`.
// A table (.xlsx, .xlsm, .csv) is opened by the studio, in the folder, as a
// table to read; every other file downloads, as a link always did.
// Pure, so it can be tested: page.ts reads location at import time. The
// click itself is fileLinkLive.ts.

const FOLDER_FILE = /^\/(?:project-v4\/sessions\/[A-Za-z0-9_-]{1,64}|element-v4\/folder)\/files\/([A-Za-z0-9_-]{1,64})$/;
const TABLE_NAME = /\.(xlsx|xlsm|csv)$/i;

/** The file's id when `href` is a table in the folder of the studio at
 *  `studio` (its origin) and the link is named as the file is, else null.
 *  The name is all there is to tell a table by: the address carries no type. */
export function studioTable(href: string | undefined, label: string, studio: string | null): string | null {
  if (!href || !studio || !TABLE_NAME.test(label.trim())) return null;
  let url: URL;
  try {
    url = new URL(href, studio);
  } catch {
    return null;
  }
  if (url.origin !== studio || url.search || url.hash) return null;
  const m = FOLDER_FILE.exec(url.pathname);
  return m?.[1] ?? null;
}
