import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { Query, SDKMessage, query } from '@anthropic-ai/claude-agent-sdk';
import type { ServerMessage } from '../shared/protocol.js';
import { committedProject } from './commit-receipt.js';
import { LiveSession } from './live-session.js';

const receipt = { status: 'committed', sess_id: 'project-one', rev: 1, applied_to: 'live', applied: ['level L2 (Upper @ 3000)'] };
const failedObservation = {
  commit_receipt: receipt, observation_status: 'failed',
  post_commit_errors: [{ stage: 'observation', type: 'IsADirectoryError', message: 'summary.json is a directory' }],
};

// Shape emitted by the actual CLI after committing a level and failing to
// write summary.json. Both --json and the ordinary digest + JSON tail are APIs.
test('committed receipt survives failed observation in both CLI formats', () => {
  assert.equal(committedProject(JSON.stringify(failedObservation)), 'project-one');
  assert.equal(committedProject(`applied to live: 1 op — committed rev 1\nCurrent pictures could not be confirmed.\n\n${JSON.stringify(failedObservation, null, 2)}`), 'project-one');
});

test('refusals, scratch applies and arbitrary errors are not live commit receipts', () => {
  for (const value of [
    'Error: project-one revision 1 was committed', '{}', 'null',
    JSON.stringify({ ...receipt }),
    JSON.stringify({ commit_receipt: { ...receipt, status: 'refused' } }),
    JSON.stringify({ commit_receipt: { ...receipt, applied_to: 'scratch clone one' } }),
    JSON.stringify({ commit_receipt: { ...receipt, rev: '1' } }),
    JSON.stringify({ commit_receipt: { ...receipt, rev: -1 } }),
    JSON.stringify({ commit_receipt: { ...receipt, applied: [] } }),
    JSON.stringify({ commit_receipt: { ...receipt, sess_id: '' } }),
  ]) assert.equal(committedProject(value), null, value);
});

test('real pump refreshes a failed apply only with a successful live receipt', async () => {
  const messages: SDKMessage[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  const factory: typeof query = ({ options }) => {
    options?.abortController?.signal.addEventListener('abort', () => { done = true; wake?.(); });
    return Object.assign((async function* () {
      while (!done) {
        if (!messages.length) await new Promise<void>((resolve) => { wake = resolve; });
        const next = messages.shift();
        if (next) yield next;
      }
    })(), { close() {}, interrupt: async () => {} }) as Query;
  };
  const session = new LiveSession({ cwd: '/tmp', project: 'project-one', queryFactory: factory });
  const seen: ServerMessage[] = [];
  session.subscribe((message) => seen.push(message));
  async function apply(content: string, is_error: boolean, command = 'python -m buildable.services.perceive_project_v4 project-one --apply ops.json --real') {
    const toolId = randomUUID();
    // SDK envelopes are intentionally fixture-only; actual pump and tool-result
    // observer run here, without starting a Claude process or using credentials.
    messages.push({ type: 'assistant', uuid: randomUUID(), session_id: session.sessionId, parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command } }] } } as unknown as SDKMessage);
    messages.push({ type: 'user', uuid: randomUUID(), session_id: session.sessionId, parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content, is_error }] } } as SDKMessage);
    wake?.();
    await setImmediate();
  }
  try {
    await apply('Error: permission denied before apply', true);
    await apply(JSON.stringify({ commit_receipt: { ...receipt, applied_to: 'scratch clone one' } }), true);
    assert.equal(seen.filter((message) => message.type === 'project_changed').length, 0);
    await apply(JSON.stringify(failedObservation), true);
    assert.equal(seen.filter((message) => message.type === 'project_changed').length, 1);
    await apply(JSON.stringify(failedObservation), false);
    assert.equal(seen.filter((message) => message.type === 'project_changed').length, 2);
    await apply(JSON.stringify(failedObservation), true, 'cat receipt.json');
    assert.equal(seen.filter((message) => message.type === 'project_changed').length, 2, 'unrelated reads cannot claim a mutation');
  } finally { session.close(); }
});
