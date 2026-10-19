// Files the engineer attaches to a message (paperclip, Ctrl+V or a drop).
// Each is saved in the desk's `attached/<day>/` before the message goes, so
// the agent can open it like any file there — a DXF, a PDF, a spreadsheet.
// A picture also rides inline, in front of the words, so the agent sees it
// without a step (the way Claude Code sends a pasted screenshot).

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import type { Attachment } from '../shared/protocol.js';

export const ATTACHED = 'attached';
/** Cloudflare refuses a request over 100 MB; nginx would take 500. */
export const MAX_FILE_BYTES = 95 * 1024 * 1024;
export const MAX_FILES = 10;
/** The API refuses an inline picture over 5 MB of base64; a bigger one is
 *  only named, and the agent reads it from the folder (Read shrinks it). */
const MAX_INLINE_BYTES = 3_700_000;
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** A file name safe on disk: no folders, no control characters, any script. */
export function safeName(name: string): string {
  const base = basename(name.replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return base || 'file';
}

/** Save one attached file under `<dir>/attached/<day>/`, never over another. */
export function saveAttachment(dir: string, name: string, mediaType: string, body: Buffer, now = new Date()): Attachment {
  if (!body.length) throw new Error('The file is empty');
  if (body.length > MAX_FILE_BYTES) throw new Error('The file is too large to attach (95 MB at most)');
  const day = now.toISOString().slice(0, 10);
  const folder = join(dir, ATTACHED, day);
  mkdirSync(folder, { recursive: true });
  const clean = safeName(name);
  const ext = extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  let file = clean;
  for (let n = 2; existsSync(join(folder, file)); n++) file = `${stem} (${n})${ext}`;
  writeFileSync(join(folder, file), body, { flag: 'wx' });
  return { name: clean, path: `${ATTACHED}/${day}/${file}`, mediaType: mediaType || 'application/octet-stream', size: body.length };
}

/** The attachments a client message names, each checked to be a file this
 *  desk's `attached/` holds. Anything else is refused, in words. */
export function checkAttachments(dir: string, raw: unknown): Attachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('Attachments must be a list');
  if (raw.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files in one message`);
  const root = realpathSync(resolve(dir));
  return raw.map((a) => {
    const { name, path, mediaType } = (a ?? {}) as Partial<Attachment>;
    if (typeof path !== 'string' || typeof name !== 'string' || typeof mediaType !== 'string') {
      throw new Error('An attachment arrived broken');
    }
    let real: string;
    try {
      real = realpathSync(resolve(root, path));
    } catch {
      throw new Error(`The attached file ${name} is no longer there; attach it again`);
    }
    const rel = relative(root, real);
    if (!rel.startsWith(ATTACHED + sep) || !statSync(real).isFile()) throw new Error('That file was not attached here');
    return { name, path: rel.split(sep).join('/'), mediaType, size: statSync(real).size };
  });
}

type ImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string };
};

/** A user message's content: the words alone, or the attached pictures
 *  (read from the folder) then the words. */
export function userContent(dir: string, text: string, files: readonly Attachment[]): string | Array<ImageBlock | { type: 'text'; text: string }> {
  const images: ImageBlock[] = files
    .filter((f) => INLINE.has(f.mediaType) && f.size <= MAX_INLINE_BYTES)
    .map((f) => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: f.mediaType as ImageBlock['source']['media_type'],
        data: readFileSync(join(dir, f.path)).toString('base64'),
      },
    }));
  if (!images.length) return text;
  return [...images, ...(text ? [{ type: 'text' as const, text }] : [])];
}
