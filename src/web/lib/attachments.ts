// Files the engineer attaches to a message: the paperclip, Ctrl+V or a drop.
// Each is uploaded into the desk's `attached/` folder before the message
// goes, and the message names it on a line of its own at the end, so the
// agent can open it. A picture is shrunk first: a phone photo is 4000 px and
// 5 MB, the model reads ~2000 px.

import type { Attachment } from '@shared/protocol';

/** Longest side of a picture sent. A drawing screenshot keeps its small text readable. */
export const MAX_SIDE = 2048;
/** A PNG (a screenshot: sharp lines, flat colour) stays PNG up to this size;
 *  past it, a JPEG is far smaller and reads the same. */
const PNG_KEEP_BYTES = 1_100_000;
/** Cloudflare refuses a request over 100 MB. */
export const MAX_FILE_BYTES = 95 * 1024 * 1024;
export const MAX_FILES = 10;
/** Pictures the agent sees inline (the rest it opens from the folder). */
const SEEN = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const LINE = 'Attached file: ';

/** The size a w × h picture is drawn at so its longest side is at most `max`. */
export function fitWithin(w: number, h: number, max = MAX_SIDE): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** The files in a paste or a drop. A paste of only pictures that also
 *  carries plain text (a range copied from Excel comes as text and a picture
 *  of it) is text: the engineer meant the words. */
export function transferFiles(data: Pick<DataTransfer, 'files' | 'getData'> | null, paste = false): File[] {
  if (!data) return [];
  const files = Array.from(data.files);
  if (paste && files.every((f) => f.type.startsWith('image/')) && data.getData('text/plain')) return [];
  return files;
}

/** The words sent: what was typed, then one line per attached file. */
export function withAttachments(text: string, files: readonly Pick<Attachment, 'path'>[]): string {
  if (!files.length) return text;
  const lines = files.map((f) => `${LINE}${f.path}`).join('\n');
  return text ? `${text}\n\n${lines}` : lines;
}

/** A sent message's words and the files its last lines name. */
export function splitAttachments(text: string): { text: string; files: string[] } {
  const lines = text.split('\n');
  const files: string[] = [];
  while (lines.length && lines[lines.length - 1]!.startsWith(LINE)) files.unshift(lines.pop()!.slice(LINE.length));
  if (!files.length) return { text, files };
  return { text: lines.join('\n').trimEnd(), files };
}

/** A file the agent was shown as a picture, so its bubble shows it as one. */
export function isPicturePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(path);
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export type Shrunk = { blob: Blob; name: string; mediaType: string; data: string };

/** A picture, shrunk for the message; null when the browser cannot draw it
 *  (then it goes as it is, a file like any other). */
export async function shrinkPicture(file: File): Promise<Shrunk | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const { w, h } = fitWithin(bitmap.width, bitmap.height);
  const same = w === bitmap.width && h === bitmap.height;
  // small enough as it is: the file itself, untouched
  if (same && SEEN.has(file.type) && file.size <= PNG_KEEP_BYTES) {
    bitmap.close();
    return { blob: file, name: file.name || 'picture.png', mediaType: file.type, data: await base64(file) };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  const stem = (file.name || 'picture').replace(/\.[^.]+$/, '');
  if (file.type === 'image/png') {
    ctx.drawImage(bitmap, 0, 0, w, h);
    const png = await encode(canvas, 'image/png');
    if (png.size <= PNG_KEEP_BYTES) {
      bitmap.close();
      return { blob: png, name: `${stem}.png`, mediaType: 'image/png', data: await base64(png) };
    }
  }
  // JPEG has no transparency: paper white under it, like a sheet
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const jpeg = await encode(canvas, 'image/jpeg', 0.88);
  return { blob: jpeg, name: `${stem}.jpg`, mediaType: 'image/jpeg', data: await base64(jpeg) };
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be encoded'))), type, quality),
  );
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('The file could not be read'));
    r.readAsDataURL(blob);
  });
}
