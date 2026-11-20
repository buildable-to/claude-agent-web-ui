import assert from 'node:assert/strict';
import { test } from 'node:test';

import { studioFile } from './fileLink';

// the id of the file a link is taken for, or null when it stays a plain link
const studioTable = (href: string | undefined, label: string, studio: string | null) => {
  const f = studioFile(href, label, studio);
  return f && f.opens ? f.id : null;
};

// A click on a table's link is taken from the browser and handed to the
// studio, so only a link that is surely a table in the studio's own folder
// may be taken: anything else must stay a plain link.

const APP = 'https://app.buildable.to';

test('a table in the project folder is the studio\'s to open', () => {
  assert.equal(studioTable(`${APP}/project-v4/sessions/s-1a2b/files/9a786865cf3c`, 'ხარჯთაღრიცხვა v2.xlsx', APP), '9a786865cf3c');
  assert.equal(studioTable(`${APP}/project-v4/sessions/s-1a2b/files/9a786865cf3c`, 'Piece marks.CSV ', APP), '9a786865cf3c');
});

test('a table in the library folder too', () => {
  assert.equal(studioTable(`${APP}/element-v4/folder/files/ab12cd34ef56`, 'Bar list.xlsm', APP), 'ab12cd34ef56');
});

test('a PDF in the folder is the studio\'s to open too', () => {
  assert.equal(studioTable(`${APP}/project-v4/sessions/s-1/files/863f98a45d75`, 'Audit 2026-11-19.pdf', APP), '863f98a45d75');
});

test('a link not named as a table file downloads as before', () => {
  assert.equal(studioTable(`${APP}/project-v4/sessions/s-1/files/9a786865cf3c`, 'the estimate', APP), null);
  assert.equal(studioTable(`${APP}/project-v4/sessions/s-1/files/9a786865cf3c`, 'Set.dxf', APP), null);
  assert.equal(studioTable(`${APP}/project-v4/sessions/s-1/files/9a786865cf3c`, 'old.xls', APP), null);
});

test('only the studio\'s own folder addresses', () => {
  assert.equal(studioTable('https://evil.example/project-v4/sessions/s-1/files/9a786865cf3c', 'a.xlsx', APP), null);
  assert.equal(studioTable(`${APP}/project-v4/sessions/s-1/files/9a786865cf3c/table`, 'a.xlsx', APP), null);
  assert.equal(studioTable(`${APP}/project-v4/sessions/s-1/files/9a786865cf3c?x=1`, 'a.xlsx', APP), null);
  assert.equal(studioTable(`${APP}/static/a.xlsx`, 'a.xlsx', APP), null);
  assert.equal(studioTable('javascript:alert(1)', 'a.xlsx', APP), null);
});

test('standalone, with no studio around, nothing is taken', () => {
  assert.equal(studioTable(`${APP}/project-v4/sessions/s-1/files/9a786865cf3c`, 'a.xlsx', null), null);
  assert.equal(studioTable(undefined, 'a.xlsx', APP), null);
});

test('a file is drawn by its kind, and only a table or a PDF opens in the studio', () => {
  const at = `${APP}/project-v4/sessions/s-1/files/9a786865cf3c`;
  assert.deepEqual(studioFile(at, 'ხარჯთაღრიცხვა v2.xlsx', APP), {
    id: '9a786865cf3c', name: 'ხარჯთაღრიცხვა v2.xlsx', tag: 'XLSX', tone: 'table', what: 'Excel table', opens: true });
  assert.deepEqual(studioFile(at, 'Audit.pdf', APP), {
    id: '9a786865cf3c', name: 'Audit.pdf', tag: 'PDF', tone: 'pdf', what: 'PDF', opens: true });
  // a card too, but it downloads
  assert.equal(studioFile(at, 'Plan.dxf', APP)?.opens, false);
  assert.equal(studioFile(at, 'old.xls', APP)?.opens, false);
  assert.deepEqual(studioFile(at, 'model.step', APP), {
    id: '9a786865cf3c', name: 'model.step', tag: 'STEP', tone: 'plain', what: 'File', opens: false });
  // a link in words, not a file name, stays a plain link
  assert.equal(studioFile(at, 'the estimate', APP), null);
});
