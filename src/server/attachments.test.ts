import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkAttachments, safeName, saveAttachment, userContent } from './attachments.js';

const desk = () => mkdtempSync(join(tmpdir(), 'desk-'));
const day = new Date('2026-10-19T12:00:00Z');
const PNG = Buffer.from('iVBORw0KGgo=', 'base64');

test('a file is saved under attached/<day>/, never over another of the same name', () => {
  const dir = desk();
  const a = saveAttachment(dir, 'B-3 beam.dxf', 'image/vnd.dxf', Buffer.from('0\nSECTION'), day);
  const b = saveAttachment(dir, 'B-3 beam.dxf', 'image/vnd.dxf', Buffer.from('0\nEOF'), day);
  assert.equal(a.path, 'attached/2026-10-19/B-3 beam.dxf');
  assert.equal(b.path, 'attached/2026-10-19/B-3 beam (2).dxf');
  assert.equal(readFileSync(join(dir, a.path), 'utf8'), '0\nSECTION');
  assert.equal(a.size, 9);
});

test('a name cannot climb out of the folder; any script stays', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('C:\\Users\\x\\ნახაზი.pdf'), 'ნახაზი.pdf');
  assert.equal(safeName('.hidden'), 'hidden');
  assert.equal(safeName(''), 'file');
});

test('an empty file is refused in words', () => {
  assert.throws(() => saveAttachment(desk(), 'x.txt', 'text/plain', Buffer.alloc(0)), /empty/);
});

test('a message may only name files this desk has attached', () => {
  const dir = desk();
  const a = saveAttachment(dir, 'shot.png', 'image/png', PNG, day);
  assert.deepEqual(checkAttachments(dir, [a]), [a]);
  assert.deepEqual(checkAttachments(dir, undefined), []);
  writeFileSync(join(dir, 'CLAUDE.md'), 'desk');
  assert.throws(() => checkAttachments(dir, [{ ...a, path: 'CLAUDE.md' }]), /not attached here/);
  assert.throws(() => checkAttachments(dir, [{ ...a, path: '../../etc/hostname' }]), /not attached here|no longer there/);
  assert.throws(() => checkAttachments(dir, [{ ...a, path: 'attached/2026-10-19/gone.png' }]), /no longer there/);
  assert.throws(() => checkAttachments(dir, 'x'), /list/);
});

test('pictures ride inline in front of the words; other files only by their path in the words', () => {
  const dir = desk();
  const shot = saveAttachment(dir, 'shot.png', 'image/png', PNG, day);
  const dxf = saveAttachment(dir, 'beam.dxf', 'application/dxf', Buffer.from('0'), day);
  assert.equal(userContent(dir, 'hi', []), 'hi');
  assert.equal(userContent(dir, 'see it', [dxf]), 'see it');
  assert.deepEqual(userContent(dir, 'look', [shot, dxf]), [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
    { type: 'text', text: 'look' },
  ]);
});
