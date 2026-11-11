// Credits (ezdxf-flask docs/billing.md): before the engineer's message starts
// a turn, ask the app whether the account may run one. What a run cost is not
// sent from here: the run record (run-log.ts) already carries it, and the
// app's run door takes it off the account's credits.
//
// The app decides; this only asks. If the app cannot be reached, or answers
// anything but a clear "no", the turn runs: billing must never take the agent
// down. A turn already running is never stopped.

import { signToken } from './accounts.js';

/** The audience of the token the app's billing door accepts, and no other. */
export const BILLING_AUDIENCE = 'buildable-billing';

/** Why this account may not start a turn now, or null when it may. */
export type CreditCheck = (accountId: string) => Promise<string | null>;

type Answer = { allowed?: unknown; message?: unknown; billing_url?: unknown };

/** The words the page shows: the app's own message and where to buy more. */
export function refusalText(answer: Answer): string {
  const message =
    typeof answer.message === 'string' && answer.message.trim()
      ? answer.message.trim()
      : 'You have no agent credits left.';
  const url = typeof answer.billing_url === 'string' ? answer.billing_url : '';
  return url ? `${message} ${url}` : message;
}

/** A check against the app at `appUrl`, signed with the secret it shares
 *  with the app; null (no check) without either: a laptop, or dev mode. */
export function creditCheck(opts: {
  appUrl: string | undefined;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): CreditCheck | null {
  if (!opts.appUrl || !opts.secret) return null;
  let url: string;
  try {
    url = new URL('/billing/agent/check', opts.appUrl).toString();
  } catch {
    console.error(`[billing] BUILDABLE_URL is not a URL: ${opts.appUrl}; credits are not checked`);
    return null;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 4000;
  return async (accountId) => {
    const now = Math.floor(Date.now() / 1000);
    const token = signToken({ sub: 'agent-service', role: 'agent-service', aud: BILLING_AUDIENCE, exp: now + 60 }, opts.secret);
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ user_id: accountId }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        console.error(`[billing] check for ${accountId}: HTTP ${res.status}; the turn runs`);
        return null;
      }
      const answer = (await res.json()) as Answer;
      return answer.allowed === false ? refusalText(answer) : null;
    } catch (err) {
      console.error(`[billing] check for ${accountId} failed: ${String(err)}; the turn runs`);
      return null;
    }
  };
}
