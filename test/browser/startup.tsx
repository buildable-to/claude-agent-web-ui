// A real mounted composer and transport. The Node test hosts the actual server;
// only SDK process creation and deliberate network delivery delays are fixtures.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatInput } from '../../src/web/components/ChatInput';
import { useSession } from '../../src/web/state/useSession';
import { ws } from '../../src/web/lib/ws';

type Snapshot = {
  commands: { type: string; requestId?: string; uuid?: string; sessionId?: string; text?: string }[];
  engines: { sessionId: string; prompts: { text: string; uuid: string }[]; aborted: boolean }[];
  attempts: number;
  attachments: number;
  historyWaiting: number;
  openWaiting: boolean;
};

let session: ReturnType<typeof useSession>;
let setDraft: (value: string) => void;
let chooseChat: (id: string | null) => void;
const account = new URLSearchParams(location.search).get('account')!;

function Harness() {
  const [selected, setSelected] = useState<{ id: string | null; nonce: number }>({ id: account.startsWith('known-') ? 'saved-beam' : null, nonce: 0 });
  const [draft, set] = useState('');
  session = useSession(selected.id, selected.nonce);
  setDraft = set;
  chooseChat = (id) => setSelected((previous) => ({ id, nonce: previous.nonce + 1 }));
  return <>
    <button id="new-chat" onClick={() => chooseChat(null)}>New chat</button>
    <button id="retry" onClick={session.retrySend}>Retry sending</button>
    <ChatInput value={draft} onChange={set} status={session.state.status} stopping={session.stopping}
      backgroundWork={session.state.backgroundWork} onSend={session.send}
      onStop={session.stopWork} commands={[]} commandsLoading={false}/>
  </>;
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 15));
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function until(condition: () => unknown | Promise<unknown>, description: string) {
  const deadline = Date.now() + 8_000;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await pause();
  }
}
async function control(action = 'snapshot'): Promise<Snapshot> {
  const response = await fetch(`/control?account=${encodeURIComponent(account)}&action=${action}`);
  check(response.ok, `Control failed: ${action}`);
  return response.json();
}
async function submit(text: string, via: 'button' | 'enter' = 'button') {
  setDraft(text);
  await until(() => document.querySelector('textarea')?.value === text, 'draft rendering');
  if (via === 'button') {
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
    check(!button.disabled, 'Composer must allow a follow-up while starting');
    button.click();
  } else {
    document.querySelector('textarea')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  }
  await until(() => document.querySelector('textarea')?.value === '', 'draft clearing');
}
function texts(snapshot: Snapshot, index = 0) {
  return snapshot.engines[index]?.prompts.map((p) => p.text) ?? [];
}
function equal(actual: unknown, expected: unknown, description: string) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${description}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
async function finishedPrompts(expected: number) {
  await until(async () => (await control()).engines.reduce((n, e) => n + e.prompts.length, 0) === expected, 'SDK prompt delivery');
  return control();
}
function assertVisiblePrompts(expected: string[]) {
  equal(session.state.transcript.turns.filter((t) => t.kind === 'user').map((t) => t.text), expected, 'Visible user messages');
}

async function knownSession() {
  const prompts = ['Make a beam', 'Use 600 mm depth'];
  await until(() => session.state.status === 'idle' && session.state.sessionId === 'saved-beam', 'saved conversation history loaded');
  await submit(prompts[0]!);
  await submit(prompts[1]!, 'enter');
  if (account === 'known-failed-navigation') {
    await until(async () => (await control()).openWaiting, 'resume lookup waiting');
    await control('fail-open');
    await until(() => session.state.error, 'failed resume reported');
    check(session.pendingSendCount === 2, 'Both failed resume prompts remain queued');
  } else await until(async () => (await control()).engines.length === 1, 'resumed engine starts');

  document.getElementById('new-chat')!.click();
  await until(() => session.state.sessionId === null && session.pendingSendCount === 0, 'navigated away from saved conversation');
  if (account === 'known-history-race') await control('hold-history');
  chooseChat('saved-beam');

  if (account === 'known-failed-navigation') {
    await until(() => session.pendingSendCount === 2 && session.state.error, 'failed queue and retry restored on return');
    assertVisiblePrompts(prompts);
    check(session.state.error!.includes('Simulated resume failure'), 'Original failure remains visible');
    document.getElementById('retry')!.click();
    await until(async () => (await control()).engines.length === 1, 'explicit retry resumes');
    await control('release');
  } else {
    await until(async () => (await control()).historyWaiting === 1, 'returned conversation history is still pending');
    await control('release');
    await finishedPrompts(2);
    let sawLiveOutput = false;
    const unsubscribe = ws.subscribe((message) => {
      if (message.type === 'message' && message.message.type === 'assistant') sawLiveOutput = true;
    });
    await control('emit-output');
    await until(() => sawLiveOutput, 'SDK output arrived while HTTP history remains blocked');
    unsubscribe();
    // The HTTP snapshot is deliberately older than both the attachment and
    // SDK output. Releasing it must not replace either those events or prompts.
    await control('release-history');
    await until(() => session.state.transcript.turns.some((turn) => turn.kind === 'assistant'
      && turn.blocks.some((block) => block.type === 'text' && block.text === 'The beam is ready for review.')), 'live output survives delayed history');
  }
  await until(() => session.pendingSendCount === 0 && session.state.attached, 'pending resume queue drained');
  const result = await finishedPrompts(2);
  equal(texts(result), prompts, 'Restored resume prompts delivered once, in order');
  assertVisiblePrompts(prompts);
  equal(session.state.sessionId, 'saved-beam', 'Saved conversation remains selected');
  equal(result.engines.length, 1, 'Navigation and retry never fork the saved conversation');
  equal(result.commands.filter((m) => m.type === 'attach').length, 1, 'Returning to a pending resume does not send a redundant plain attachment');
  const starts = result.commands.filter((m) => m.type === 'start');
  equal(starts.length, account === 'known-failed-navigation' ? 2 : 1, 'Only the explicit failed resume is retried');
  check(starts.every((m) => m.requestId === starts[0]!.requestId && m.uuid === starts[0]!.uuid), 'Failed resume preserves request and prompt identity');
  return result;
}

async function run() {
  createRoot(document.getElementById('root')!).render(<Harness/>);
  ws.connect();
  await until(() => session && ws.state === 'open' && document.querySelector('textarea'), 'mounted connected composer');
  // Let the mounted effects subscribe before dispatching the first user event.
  await pause();

  if (account.startsWith('known-')) return knownSession();

  if (account === 'attached-control') await control('release');
  await submit('Make a beam');

  if (account === 'failure-retry') {
    await until(() => session.state.error, 'startup failure reported');
    check(session.pendingSendCount === 1, 'Failed first prompt must remain queued');
    document.getElementById('retry')!.click();
    await until(async () => (await control()).engines.length === 1, 'successful retry');
  } else {
    await until(async () => (await control()).engines.length === 1, 'first engine startup');
  }

  if (account === 'attached-control') await until(() => session.state.sessionId, 'first attachment');
  await submit('Use 600 mm depth', account === 'delayed-button' ? 'button' : 'enter');

  if (account === 'attached-control') {
    const result = await finishedPrompts(2);
    equal(result.commands.map((m) => m.type), ['start', 'send'], 'Attached control commands');
    equal(texts(result), ['Make a beam', 'Use 600 mm depth'], 'Attached prompt order');
    check(result.engines.length === 1, 'Attached control must have one engine');
    assertVisiblePrompts(['Make a beam', 'Use 600 mm depth']);
    return result;
  }

  const waiting = await control();
  check(waiting.engines.length === 1, 'Queued follow-up must not start another engine');
  equal(texts(waiting), ['Make a beam'], 'Follow-up waits for attachment');
  check(waiting.commands.every((m) => m.type !== 'send'), 'No follow-up can be sent before its owner attaches');

  if (account === 'switch-back') {
    const id = waiting.engines[0]!.sessionId;
    document.getElementById('new-chat')!.click();
    await until(() => session.pendingSendCount === 0, 'navigated away from pending start');
    chooseChat(id);
    await until(async () => (await control()).attachments === 2, 'plain attachment to the same conversation');
    // Deliver the new selection's plain attach first; the older correlated
    // start reply must neither overwrite it nor detach its server subscription.
    await control('release-last');
    await until(() => session.state.attached && session.state.sessionId === id, 'selected existing conversation attached');
    await control('release-first');
    const result = await finishedPrompts(2);
    equal(texts(result), ['Make a beam', 'Use 600 mm depth'], 'Original owner still delivers its queued prompt');
    check(result.commands.every((m) => m.type !== 'detach'), 'Late start reply must not detach the current same-ID subscription');
    await control('emit-output');
    await until(() => session.state.transcript.turns.some((turn) => turn.kind === 'assistant'
      && turn.blocks.some((block) => block.type === 'text' && block.text === 'The beam is ready for review.')), 'new SDK output still reaches the selected chat');
    equal(session.state.sessionId, id, 'Same conversation remains selected');
    return result;
  }

  if (account === 'switch-chat') {
    document.getElementById('new-chat')!.click();
    await until(() => session.pendingSendCount === 0, 'new chat selection');
    await submit('Make a column');
    await until(async () => (await control()).engines.length === 2, 'second selected chat startup');
    await control('release-first');
    await until(async () => (await control()).commands.some((m) => m.type === 'detach'), 'late old chat detached');
    check(session.state.sessionId === null, 'Late attachment must not hijack the selected new chat');
    assertVisiblePrompts(['Make a column']);
    await control('release');
    await until(() => session.state.sessionId, 'selected new chat attaches');
    const result = await finishedPrompts(3);
    equal(texts(result, 0), ['Make a beam', 'Use 600 mm depth'], 'Old chat owns its queued prompt');
    equal(texts(result, 1), ['Make a column'], 'New chat owns only its prompt');
    equal(session.state.sessionId, result.engines[1]!.sessionId, 'Selected conversation identity');
    return result;
  }

  if (account === 'stop-startup') {
    document.querySelector<HTMLButtonElement>('button[aria-label="Stop work"]')!.click();
    await until(() => session.pendingSendCount === 0, 'queued follow-up cancelled');
    setDraft('Continue after stopping');
    await until(() => document.querySelector('textarea')?.value === 'Continue after stopping', 'new post-stop draft');
    document.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await pause();
    equal(document.querySelector('textarea')?.value, 'Continue after stopping', 'Rejected send while stopping preserves the new draft');
    await control('release');
    await until(async () => (await control()).engines[0]?.aborted, 'first engine stopped');
    const result = await control();
    equal(texts(result), ['Make a beam'], 'Cancelled follow-up never reaches SDK');
    check(result.commands.some((m) => m.type === 'stop_work'), 'Stop follows the original attachment');
    check(result.commands.every((m) => m.type !== 'send'), 'Stopped startup must not flush follow-ups');
    return result;
  }

  if (account === 'lost-reply') await control('disconnect');
  else await control('release');

  const result = await finishedPrompts(2);
  await until(() => session.state.sessionId && session.pendingSendCount === 0, 'queue drained after attachment');
  check(result.engines.length === 1, 'A retried start must keep one engine');
  equal(texts(result), ['Make a beam', 'Use 600 mm depth'], 'Prompts delivered exactly once in order');
  equal(session.state.sessionId, result.engines[0]!.sessionId, 'Selected conversation owns both prompts');
  assertVisiblePrompts(['Make a beam', 'Use 600 mm depth']);
  const starts = result.commands.filter((m) => m.type === 'start');
  equal(starts.length, account === 'lost-reply' || account === 'failure-retry' ? 2 : 1, 'Number of starts');
  check(starts.every((m) => m.requestId === starts[0]!.requestId && m.uuid === starts[0]!.uuid), 'Retry preserves both request and prompt identity');
  check(new Set(result.engines[0]!.prompts.map((p) => p.uuid)).size === 2, 'Distinct user prompts keep distinct IDs');
  if (account === 'failure-retry') equal(result.attempts, 2, 'Explicit retry after the failed launch');
  return result;
}

// CDP awaits the promise; a failed browser assertion fails the Node test.
Object.assign(globalThis, { startupResult: run() });
