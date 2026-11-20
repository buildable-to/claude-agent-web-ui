import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { Query, SDKMessage, SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk';
import { DROPPED_STEP_RETRY_TEXT, LiveSession } from './live-session.js';

// Seen on the server 2026-11-20: the agent wrote a question to the engineer,
// the engine ended the turn with an error without ever showing it, and the
// chat sat for over an hour with only a red line.

function engine() {
  const messages: Array<SDKMessage | null> = [];
  const said: string[] = [];
  let wake: (() => void) | undefined;
  const factory: typeof query = (args) => {
    args.options?.abortController?.signal.addEventListener('abort', () => { messages.push(null); wake?.(); });
    if (typeof args.prompt !== 'string') {
      void (async () => {
        for await (const m of args.prompt as AsyncIterable<SDKUserMessage>) said.push(String(m.message.content));
      })();
    }
    const stream = (async function* () {
      while (true) {
        if (!messages.length) await new Promise<void>((resolve) => { wake = resolve; });
        const value = messages.shift();
        if (value === null || value === undefined) return;
        yield value;
      }
    })();
    return Object.assign(stream, { interrupt: async () => undefined, stopTask: async () => undefined, close: () => {} }) as unknown as Query;
  };
  async function emit(message: unknown) {
    messages.push(message as SDKMessage);
    wake?.();
    await setImmediate();
    await setImmediate();
  }
  const base = () => ({ uuid: randomUUID(), session_id: 'test', parent_tool_use_id: null });
  return {
    factory,
    said,
    asks: (id: string) => emit({ type: 'assistant', ...base(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: {} }] } }),
    answered: (id: string) => emit({ type: 'user', ...base(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }),
    result: (ok: boolean) => emit({
      type: 'result', subtype: ok ? 'success' : 'error_during_execution', is_error: !ok, result: 'done',
      errors: ok ? undefined : ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'],
      duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: null, total_cost_usd: 0, usage: {}, permission_denials: [], modelUsage: {}, ...base(),
    }),
  };
}

function session(cli: ReturnType<typeof engine>) {
  return new LiveSession({ cwd: process.cwd(), queryFactory: cli.factory });
}

test('a turn that ends in an error on a step the engine never ran is continued, once', async () => {
  const cli = engine();
  const s = session(cli);
  s.send('build it');
  await cli.asks('t1');
  await cli.result(false);
  assert.deepEqual(cli.said, ['build it', DROPPED_STEP_RETRY_TEXT]);
  // it fails the same way again: now it is the engineer's to see
  await cli.asks('t2');
  await cli.result(false);
  assert.deepEqual(cli.said, ['build it', DROPPED_STEP_RETRY_TEXT]);
  // a turn that ended well in between gives the next failure its own retry
  await cli.result(true);
  await cli.asks('t3');
  await cli.result(false);
  assert.deepEqual(cli.said, ['build it', DROPPED_STEP_RETRY_TEXT, DROPPED_STEP_RETRY_TEXT]);
  s.close();
});

test('an error after every step was answered, and one after Stop, are left alone', async () => {
  const cli = engine();
  const s = session(cli);
  s.send('build it');
  await cli.asks('t1');
  await cli.answered('t1');
  await cli.result(false);
  assert.deepEqual(cli.said, ['build it']);
  s.send('again');
  await cli.asks('t2');
  await s.interrupt();
  await cli.result(false);
  assert.deepEqual(cli.said, ['build it', 'again']);
  s.close();
});
