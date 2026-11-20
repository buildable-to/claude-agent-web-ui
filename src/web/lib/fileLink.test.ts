import assert from 'node:assert/strict';
import { test } from 'node:test';

import { studioTable } from './fileLink';

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

test('a link not named as a table file downloads as before', () => {
  assert.equal(studioTable(`${APP}/project-v4/sessions/s-1/files/9a786865cf3c`, 'the estimate', APP), null);
  assert.equal(studioTable(`${APP}/project-v4/sessions/s-1/files/9a786865cf3c`, 'Set.pdf', APP), null);
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
