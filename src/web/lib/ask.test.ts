import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASK_CHARS, firstAsk, readAsk, withoutAsk } from './ask';
import type { Store } from './scope';

function memory(): Store {
  const data: Record<string, string> = {};
  return { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

const STUDIO = '?embed=1&project=p1&token=t';

test('the request is read from the address, trimmed and capped', () => {
  assert.equal(readAsk(`${STUDIO}&ask=%20A%20warehouse%2024%20%C3%97%2060%20m%20`), 'A warehouse 24 × 60 m');
  assert.equal(readAsk(STUDIO), null);
  assert.equal(readAsk(`${STUDIO}&ask=%20%20`), null);
  assert.equal(readAsk(`${STUDIO}&ask=${'x'.repeat(ASK_CHARS + 50)}`)!.length, ASK_CHARS);
});

test('a link that names a conversation never sends the request', () => {
  assert.equal(readAsk(`${STUDIO}&ask=hello&conversation=c1`), null);
});

test('only the studio\'s own embed sends: a bare link never leans on a remembered token', () => {
  assert.equal(readAsk('?ask=run%20this'), null);
  assert.equal(readAsk('?embed=1&ask=run%20this'), null);
  assert.equal(readAsk('?embed=1&project=p1&ask=run%20this'), null);
  assert.equal(readAsk('?project=p1&token=t&ask=run%20this'), null);
});

test('the address loses ask= and keeps the rest', () => {
  const out = withoutAsk('https://a.example/agent/?embed=1&project=p&ask=hi&token=t');
  assert.equal(out, 'https://a.example/agent/?embed=1&project=p&token=t');
});

test('the same words send once per project per tab', () => {
  const store = memory();
  assert.equal(firstAsk('A beam', 'p1', store), true);
  assert.equal(firstAsk('A beam', 'p1', store), false);
  assert.equal(firstAsk('A beam', 'p2', store), true, 'the same words on another project are its own');
  assert.equal(firstAsk('A column', 'p1', store), true);
  assert.equal(firstAsk('A beam', 'p1', null), true, 'no storage: the address guard alone');
});
