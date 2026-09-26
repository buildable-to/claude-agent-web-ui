import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PermissionRequest, SDKMessage, ServerMessage, StoppedWorkNotice } from '@shared/protocol';
import { ChatInput } from '../components/ChatInput';
import { initialSessionState, sessionReducer, type SessionState } from './session-state';
import { emptyTranscript, runningAgents } from './transcript';

const event = (state: SessionState, message: ServerMessage) => sessionReducer(state, { type: 'server', message });
const background = (count: number, ambient = 0): SDKMessage => ({
  type: 'system', subtype: 'background_tasks_changed', uuid: '10000000-0000-4000-8000-000000000001', session_id: 's',
  tasks: Array.from({ length: count + ambient }, (_, i) => ({
    task_id: `task-${i}`, task_type: i === 1 ? 'shell' : 'agent', description: 'Build', ambient: i >= count,
  })),
});
const attached = (backgroundWork?: number, replay: SDKMessage[] = []): ServerMessage => ({
  type: 'attached', sessionId: 's', cwd: '/account', status: 'idle', backgroundWork,
  replay, pending: [], meta: {}, stoppedWork: [],
});
const permission: PermissionRequest = {
  requestId: 'permission-1', toolUseId: 'tool-1', toolName: 'Bash', input: {}, canAlwaysAllow: false, createdAt: 1,
};
const notice: StoppedWorkNotice = {
  id: 'stop-1', sessionId: 's', reason: 'user_stop', detectedAt: 3, lastActiveAt: 2,
};
function renderComposer(state: SessionState) {
  return renderToStaticMarkup(createElement(ChatInput, {
    value: '', onChange() {}, status: state.status, backgroundWork: state.backgroundWork,
    onSend() {}, onStop() {}, commands: [], commandsLoading: false,
  }));
}
const stopButton = /aria-label="Stop work"/;

test('idle coordinator with current builders exposes Stop in the actual composer', () => {
  let state = event(initialSessionState('s'), attached(2));
  assert.equal(state.status, 'idle');
  assert.equal(state.backgroundWork, 2);
  assert.match(renderComposer(state), stopButton);

  // Authoritative membership includes background commands but excludes housekeeping.
  state = event(state, { type: 'message', sessionId: 's', message: background(2, 1) });
  assert.equal(state.backgroundWork, 2);
  assert.match(renderComposer(state), stopButton);
  state = event(state, { type: 'message', sessionId: 's', message: background(0, 1) });
  assert.equal(state.backgroundWork, 0);
  assert.doesNotMatch(renderComposer(state), stopButton);
  state = event(state, { type: 'message', sessionId: 's', message: background(0) });
  assert.doesNotMatch(renderComposer(state), stopButton);
});

test('reconnect uses current task membership and older attached messages use the last replay snapshot', () => {
  const replay = [background(2), background(1, 1)];
  const recovered = event(initialSessionState('s'), attached(undefined, replay));
  assert.equal(recovered.backgroundWork, 1);
  assert.match(renderComposer(recovered), stopButton);
  const completed = event(recovered, attached(0, replay));
  assert.equal(completed.backgroundWork, 0, 'explicit current zero wins over stale replay');
  assert.doesNotMatch(renderComposer(completed), stopButton);
});

test('foreground startup, running, and permission waits remain stoppable without background work', () => {
  for (const status of ['starting', 'running', 'requires_action'] as const) {
    assert.match(renderComposer({ ...initialSessionState('s'), status }), stopButton, status);
  }
  for (const status of ['connecting', 'idle', 'closed'] as const) {
    assert.doesNotMatch(renderComposer({ ...initialSessionState('s'), status }), stopButton, status);
  }
});

test('durable user stop settles pending permissions, running builder lanes, and background Stop visibility', () => {
  let state: SessionState = {
    ...event(initialSessionState('s'), attached(2)), pending: [permission],
    transcript: {
      ...emptyTranscript(),
      turns: [{
        kind: 'assistant', id: 'coordinator', open: false,
        blocks: ['builder-1', 'builder-2'].map((id) => ({
          type: 'tool_use', id, name: 'Agent', input: {}, done: true,
          result: 'Async agent launched successfully', images: [], children: [], task: { status: 'running' },
        })),
      }],
    },
  };
  assert.equal(runningAgents(state.transcript), 2);
  state = event(state, { type: 'work_stopped', sessionId: 's', notice });
  assert.equal(state.backgroundWork, 0);
  assert.equal(state.status, 'closed');
  assert.equal(state.attached, false);
  assert.equal(state.stopNotified, true);
  assert.deepEqual(state.pending, []);
  assert.equal(runningAgents(state.transcript), 0);
  assert.doesNotMatch(renderComposer(state), stopButton);
  const notices = state.transcript.turns.filter((turn) => turn.kind === 'note');
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.stoppedWork?.reason, 'user_stop');
  const repeated = event(state, { type: 'work_stopped', sessionId: 's', notice });
  assert.equal(repeated, state);
});

test('closed or absent engines clear stale background Stop membership', () => {
  const state = event(initialSessionState('s'), attached(2));
  for (const message of [
    { type: 'status', sessionId: 's', status: 'closed' },
    { type: 'not_live', sessionId: 's', stoppedWork: [] },
  ] satisfies ServerMessage[]) {
    const settled = event(state, message);
    assert.equal(settled.backgroundWork, 0);
    assert.doesNotMatch(renderComposer(settled), stopButton);
  }
});

async function chromeExecutable(): Promise<string | undefined> {
  const candidates = [
    process.env.CHROME_BIN,
    ...(process.env.PATH ?? '').split(delimiter).flatMap((dir) =>
      ['google-chrome', 'chromium', 'chromium-browser'].map((name) => join(dir, name))),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* try the next executable */ }
  }
}

test('mounted composer Stop and Escape stop builders, while pickers and IME retain keyboard precedence', async (t) => {
  const chrome = await chromeExecutable();
  if (!chrome) return t.skip('Install Chromium or set CHROME_BIN to exercise mounted browser interactions.');
  const project = fileURLToPath(new URL('../../..', import.meta.url));
  const work = await mkdtemp(join(tmpdir(), 'stop-work-browser-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const component = fileURLToPath(new URL('../components/ChatInput.tsx', import.meta.url));
  const reducer = fileURLToPath(new URL('./session-state.ts', import.meta.url));
  // Real React, reducer, composer, picker components and DOM event handlers.
  // No API, WebSocket, SDK process, model request, or personal browser profile.
  const entry = `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ChatInput} from ${JSON.stringify(component)};
    import {initialSessionState,sessionReducer} from ${JSON.stringify(reducer)};
    let setDraft, setState, current, calls = 0;
    const pause = () => new Promise(resolve => setTimeout(resolve, 30));
    const check = (ok, detail) => { if (!ok) throw Error(detail); };
    function Harness() {
      const [draft, edit] = useState('');
      const [state, update] = useState({...initialSessionState('s'),status:'idle',attached:true,backgroundWork:2});
      setDraft = edit; setState = update; current = state;
      return <ChatInput value={draft} onChange={edit} status={state.status} backgroundWork={state.backgroundWork}
        onSend={() => { throw Error('Escape must not send'); }} onStop={() => calls++}
        commands={[{name:'build',description:'Build a beam'}]} commandsLoading={false}
        mentions={{project:'p',library:[],marks:[{mark:'C1',element:{id:'e',name:'Column',kind:'column'},count:2,ids:['a','b']}]}} />;
    }
    (async () => {
      const host = document.getElementById('app'); const root = createRoot(host);
      root.render(<Harness/>); await pause(); await pause();
      const textarea = () => host.querySelector('textarea');
      const stop = () => host.querySelector('button[aria-label="Stop work"]');
      const escape = async (composing = false) => {
        textarea().dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true,isComposing:composing}));
        await pause();
      };
      check(Boolean(stop()),'idle coordinator must expose Stop while two builders run');
      stop().click(); await pause(); check(calls === 1,'Stop button invokes cancellation');
      await escape(); check(calls === 2,'Escape invokes cancellation while foreground is idle');
      await escape(true); check(calls === 2,'IME Escape must not cancel work');
      setDraft('/build'); await pause();
      check(Boolean(host.querySelector('[role="listbox"]')),'slash picker opens');
      await escape(); check(calls === 2,'first Escape dismisses slash picker');
      check(!host.querySelector('[role="listbox"]'),'slash picker dismissed');
      await escape(); check(calls === 3,'second Escape stops work');
      setDraft('@C'); await pause(); textarea().focus(); textarea().setSelectionRange(2,2);
      textarea().dispatchEvent(new KeyboardEvent('keyup',{key:'C',bubbles:true})); await pause();
      check(Boolean(host.querySelector('[role="listbox"]')),'mention picker opens');
      await escape(); check(calls === 3,'first Escape dismisses mention picker');
      check(!host.querySelector('[role="listbox"]'),'mention picker dismissed');
      await escape(); check(calls === 4,'second Escape stops work after mention picker');
      setDraft(''); setState(state => sessionReducer(state,{type:'server',message:{type:'work_stopped',sessionId:'s',notice:${JSON.stringify(notice)}}}));
      await pause(); check(current.backgroundWork === 0 && current.status === 'closed','durable stop settles live state');
      check(!stop(),'settled stop removes Stop control'); await escape(); check(calls === 4,'idle Escape does not stop again');
      root.unmount();
      document.getElementById('results').textContent = JSON.stringify({calls,passed:true});
    })().catch(error => document.getElementById('results').textContent = JSON.stringify({error:String(error),stack:error.stack}));
  `;
  await build({
    stdin: { contents: entry, resolveDir: project, loader: 'tsx' }, bundle: true,
    outfile: join(work, 'bundle.js'), platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'web-alias', setup(builder) {
      builder.onResolve({ filter: /^@\// }, (args) => {
        const path = join(project, 'src/web', args.path.slice(2));
        return { path: existsSync(`${path}.tsx`) ? `${path}.tsx` : `${path}.ts` };
      });
    } }],
  });
  await writeFile(join(work, 'index.html'), '<html><body><div id="app"></div><pre id="results">pending</pre><script src="bundle.js"></script></body></html>');
  const output = execFileSync(chrome, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${join(work, 'profile')}`, '--virtual-time-budget=5000', '--dump-dom', `file://${join(work, 'index.html')}`,
  ], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = output.match(/<pre id="results">(.*?)<\/pre>/s)?.[1];
  assert.ok(result && result !== 'pending', 'browser harness must finish');
  const decoded = JSON.parse(result.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
  assert.deepEqual(decoded, { calls: 4, passed: true });
});
