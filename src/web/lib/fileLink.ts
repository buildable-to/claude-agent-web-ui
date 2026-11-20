// A link to a file in the studio's folder ("Files"), written by the agent in
// a reply: `[Estimate.xlsx](https://app…/project-v4/sessions/<id>/files/<file>)`.
// It is shown as a file card (FileCard.tsx). A table (.xlsx, .xlsm, .csv) or
// a PDF is opened by the studio, in the folder, to read; every other file
// downloads, as a link always did.
// Pure, so it can be tested: page.ts reads location at import time. The
// click itself is fileLinkLive.ts.

const FOLDER_FILE = /^\/(?:project-v4\/sessions\/[A-Za-z0-9_-]{1,64}|element-v4\/folder)\/files\/([A-Za-z0-9_-]{1,64})$/;
const FILE_NAME = /\.([A-Za-z0-9]{1,6})$/;

/** How a kind of file is drawn: the word on its page, the colour of that
 *  word (green a table, red a PDF, grey the rest) and what it is in words. */
type Kind = { tag: string; tone: 'table' | 'pdf' | 'plain'; what: string; opens?: true };
const KINDS: Record<string, Kind> = {
  xlsx: { tag: 'XLSX', tone: 'table', what: 'Excel table', opens: true },
  xlsm: { tag: 'XLSX', tone: 'table', what: 'Excel table', opens: true },
  csv: { tag: 'CSV', tone: 'table', what: 'Table', opens: true },
  xls: { tag: 'XLS', tone: 'table', what: 'Excel table' },
  pdf: { tag: 'PDF', tone: 'pdf', what: 'PDF', opens: true },
  dxf: { tag: 'DXF', tone: 'plain', what: 'CAD drawing' },
  dwg: { tag: 'DWG', tone: 'plain', what: 'CAD drawing' },
  ifc: { tag: 'IFC', tone: 'plain', what: 'IFC model' },
  png: { tag: 'IMG', tone: 'plain', what: 'Picture' },
  jpg: { tag: 'IMG', tone: 'plain', what: 'Picture' },
  jpeg: { tag: 'IMG', tone: 'plain', what: 'Picture' },
  webp: { tag: 'IMG', tone: 'plain', what: 'Picture' },
  md: { tag: 'NOTE', tone: 'plain', what: 'Note' },
  txt: { tag: 'NOTE', tone: 'plain', what: 'Note' },
  docx: { tag: 'DOC', tone: 'plain', what: 'Document' },
  doc: { tag: 'DOC', tone: 'plain', what: 'Document' },
  json: { tag: 'JSON', tone: 'plain', what: 'Data' },
  zip: { tag: 'ZIP', tone: 'plain', what: 'Archive' },
};

export type StudioFile = {
  /** the file's id in the folder */
  id: string;
  /** its name, as the link says it */
  name: string;
  tag: string;
  tone: Kind['tone'];
  what: string;
  /** the studio opens it in place (a table, a PDF); else it downloads */
  opens: boolean;
};

/** The file a link points at, when `href` is a file in the folder of the
 *  studio at `studio` (its origin) and the link is named as a file is
 *  ("Estimate.xlsx"), else null: the link stays a plain link. The name is all
 *  there is to tell a file's kind by: the address carries no type. */
export function studioFile(href: string | undefined, label: string, studio: string | null): StudioFile | null {
  const name = label.trim();
  const ext = FILE_NAME.exec(name)?.[1]?.toLowerCase();
  if (!href || !studio || !ext) return null;
  let url: URL;
  try {
    url = new URL(href, studio);
  } catch {
    return null;
  }
  if (url.origin !== studio || url.search || url.hash) return null;
  const id = FOLDER_FILE.exec(url.pathname)?.[1];
  if (!id) return null;
  const kind = KINDS[ext] ?? { tag: ext.length <= 4 ? ext.toUpperCase() : 'FILE', tone: 'plain' as const, what: 'File' };
  return { id, name, tag: kind.tag, tone: kind.tone, what: kind.what, opens: kind.opens === true };
}
