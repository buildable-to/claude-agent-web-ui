import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileSize, fitWithin, isPicturePath, MAX_SIDE, splitAttachments, transferFiles, withAttachments } from './attachments';

test('a big picture shrinks to the longest side, keeping its shape; a small one keeps its size', () => {
  assert.deepEqual(fitWithin(4096, 2048), { w: MAX_SIDE, h: MAX_SIDE / 2 });
  assert.deepEqual(fitWithin(1000, 3000, 1500), { w: 500, h: 1500 });
  assert.deepEqual(fitWithin(800, 600), { w: 800, h: 600 });
});

const transfer = (files: Array<{ type: string }>, text = '') =>
  ({ files, getData: (k: string) => (k === 'text/plain' ? text : '') }) as unknown as DataTransfer;

test('a paste or a drop gives its files, any kind', () => {
  const shot = { type: 'image/png' };
  const pdf = { type: 'application/pdf' };
  assert.deepEqual(transferFiles(transfer([shot, pdf])), [shot, pdf]);
  assert.deepEqual(transferFiles(transfer([shot]), true), [shot]);
  assert.deepEqual(transferFiles(null), []);
});

test('a paste that carries words is words (Excel copies a range as text and a picture)', () => {
  assert.deepEqual(transferFiles(transfer([{ type: 'image/png' }], 'A1\tB1'), true), []);
  // a file copied in Explorer may carry its name as text: still the file
  assert.equal(transferFiles(transfer([{ type: 'application/pdf' }], 'plan.pdf'), true).length, 1);
  // a drop is files the engineer chose: words beside them do not matter
  assert.equal(transferFiles(transfer([{ type: 'image/png' }], 'x')).length, 1);
});

test('the files ride as lines after the words, and fold back off for the bubble', () => {
  const files = [{ path: 'attached/2026-10-19/beam.dxf' }, { path: 'attached/2026-10-19/shot.png' }];
  const sent = withAttachments('check this', files);
  assert.equal(sent, 'check this\n\nAttached file: attached/2026-10-19/beam.dxf\nAttached file: attached/2026-10-19/shot.png');
  assert.deepEqual(splitAttachments(sent), { text: 'check this', files: files.map((f) => f.path) });
  assert.deepEqual(splitAttachments(withAttachments('', files)), { text: '', files: files.map((f) => f.path) });
  assert.equal(withAttachments('hi', []), 'hi');
  assert.deepEqual(splitAttachments('no files\nhere'), { text: 'no files\nhere', files: [] });
});

test('pictures by their name; sizes in words', () => {
  assert.equal(isPicturePath('attached/x/a.JPG'), true);
  assert.equal(isPicturePath('attached/x/a.pdf'), false);
  assert.equal(fileSize(2_500_000), '2.4 MB');
  assert.equal(fileSize(5_000), '5 KB');
});
