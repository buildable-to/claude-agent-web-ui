import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import { ConnectError, Connector, plain } from './connect.js';

const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code&scope=user%3Ainference&state=abc';
const TOKEN = 'sk-ant-oat01-' + 'Z'.repeat(60);

/** A stand-in for `claude setup-token`: prints the link (as an OSC 8 link,
 *  the way the real one does), then answers the pasted code. */
function fakeSignIn(answer: (code: string) => string) {
  let typed = '';
  const runner = () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    Object.assign(child, { stdout, stderr: new PassThrough(), stdin, kill: () => { child.emit('exit', 0); return true; } });
    setTimeout(() => stdout.write(`\x1b[1mWelcome\x1b[0m\r\nBrowser didn't open? Use the url below\r\n\x1b]8;id=1;${URL}\x07${URL}\x1b]8;;\x07\r\nPaste code here if prompted > `), 20);
    stdin.on('data', (b: Buffer) => {
      typed += b.toString();
      if (typed.endsWith('\r')) stdout.write(answer(typed.trim()));
    });
    return child;
  };
  return { runner, typed: () => typed };
}

test('the terminal text is read plainly: colours and link wrappers gone, the link text kept', () => {
  assert.equal(plain(`\x1b[1mhi\x1b[0m\r\n\x1b]8;id=1;${URL}\x07${URL}\x1b]8;;\x07`), `hi\n\n${URL}`);
});

test('connect: the link comes back, the pasted code is typed in, the login code is caught', async () => {
  const f = fakeSignIn(() => `\r\n✓ Long-lived authentication token created successfully!\r\nYour OAuth token (valid for 1 year):\r\n\r\n${TOKEN}\r\n`);
  const c = new Connector(f.runner);
  const { id, url } = await c.start();
  assert.equal(url, URL);
  assert.equal(await c.finish(id, '  abc#def  '), TOKEN);
  assert.equal(f.typed(), 'abc#def\r');
  // the flow is over: the same id cannot be finished twice
  await assert.rejects(c.finish(id, 'abc'), ConnectError);
});

test('a code Claude refuses is a ConnectError saying to sign in again', async () => {
  const f = fakeSignIn(() => '\r\nOAuth error: Invalid code. Please make sure the full code was copied\r\nPress Enter to retry.');
  const c = new Connector(f.runner);
  const { id } = await c.start();
  await assert.rejects(c.finish(id, 'wrong#state'), (e: unknown) => e instanceof ConnectError && /sign in again/.test(e.message));
});

test('an empty or unknown sign-in is refused before anything is typed', async () => {
  const f = fakeSignIn(() => '');
  const c = new Connector(f.runner);
  await assert.rejects(c.finish('nope', 'abc'), ConnectError);
  const { id } = await c.start();
  await assert.rejects(c.finish(id, '  '), ConnectError);
  // half a code (no "#state"): refused here, with a hint
  await assert.rejects(c.finish(id, 'abcdef'), (e: unknown) => e instanceof ConnectError && /#/.test(e.message));
  assert.equal(f.typed(), '');
  c.cancel(id);
});

test('a sign-in that prints the login and quits at once still hands the login over', async () => {
  const runner = () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    Object.assign(child, { stdout, stderr: new PassThrough(), stdin, kill: () => true });
    setTimeout(() => stdout.write(`${URL}\r\nPaste code here if prompted > `), 10);
    stdin.on('data', () => {
      // the process is gone before its last words are read
      child.emit('exit', 0);
      setTimeout(() => { stdout.write(`\r\nYour OAuth token (valid for 1 year):\r\n${TOKEN}\r\n`); stdout.end(); child.emit('close', 0); }, 30);
    });
    return child;
  };
  const c = new Connector(runner);
  const { id } = await c.start();
  assert.equal(await c.finish(id, 'abc#def'), TOKEN);
});
