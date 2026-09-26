# Chat reliability fixes from the overnight review

This change covers RR-1, RR-2 and the chat-service side of REL-1. The linked app
change supplies the committed mutation receipt and fixes the application
findings. No production state or real model requests were used for validation.

## Behavior

- A fresh conversation has one stable start request until attachment. Additional
  prompts stay in its outbox, then go to the acknowledged conversation once and
  in order. The server reserves the request within the account manager and
  deduplicates prompt UUIDs, including when reconnect retries a lost attachment.
- Start failures preserve queued messages and expose **Retry sending**. The page
  displays pending delivery while acknowledgement is outstanding. Late replies
  for a conversation left by the engineer deliver that conversation's queued
  prompts without selecting it over the current chat. Reopening a pending
  conversation restores its queued messages and retry state. Delayed history
  loads are applied before newer buffered live events.
- **Stop work** remains available after the coordinator finishes if nonambient
  builders or commands are still active. The button and Escape stop foreground
  work, known SDK tasks and queued prompts. Command/mention pickers and input
  method composition retain keyboard precedence. Stopping during startup drops
  queued follow-ups and cancels the engine as soon as its identity is known.
  The composer preserves any new draft typed during cancellation, including a
  submission before the disabled state has rendered.
- The account's stop operation records durable feedback before cancellation,
  settles permission requests and visible agent lanes, calls the SDK's task
  cancellation and query close APIs, and rejects late work. A stuck task-stop
  reply has a two-second bound before closing the query. Resuming while shutdown
  is in progress waits for that shutdown and shares the ordinary resume
  reservation, so cleanup cannot remove the replacement engine.
- A failed tool result refreshes the project only if the recognized apply
  command produced a validated live commit receipt. Denials, scratch applies,
  malformed receipts and arbitrary error prose are not commit evidence. The
  parser accepts both the CLI's JSON mode and its human digest plus JSON tail.

## Verification

Validation completed with **113 tests passing, zero failures and zero skips**,
including Chrome. TypeScript checks, the production build and `git diff --check`
also passed.

Run from the repository root:

```bash
npm ci
npm test
npm run typecheck
npm run build
```

The tests exercise the actual browser hook/composer, WebSocket handler, manager,
reducer, journal and tool-result pump. Browser tests require Chrome/Chromium (or `CHROME_BIN` pointing to its binary)
and report an explicit skip when it is unavailable. They run with an isolated
profile and synthetic content. The startup browser harness drives the real
socket server and replaces only the SDK engine boundary; it controls attachment
delivery to expose the original race.

The Stop work test uses the lockfile's installed SDK, its actual control
protocol and process transport, with only the CLI executable replaced by an
inert fixture. Two genuine worker processes remain active after the foreground
returns idle. An unrelated account cannot stop them; the owner sends two SDK
stop-task controls, and both workers and the CLI exit. The persisted user-stop
notice survives a fresh manager. Separate checks cover queued messages, late
permissions, ambient/completed tasks, a missing task acknowledgement and resume
while cancellation is outstanding.

The receipt tests use the real tool-result pump and both new CLI output formats.
During integration, the parser was also run on the actual app CLI's output after
its revision committed and writing summary.json failed; it recovered the correct
project identity.

## Boundaries

Start reservations and message UUID deduplication last for the current server
manager/engine lifetime. Browser outboxes live in the mounted page; this is not a
new durable offline messaging service across browser or server restarts. Existing
work-journal recovery still owns service-restart behavior. Old request identities
keep a weak reference to the original engine generation, so they neither retain
closed transcript buffers nor replay into a later resumed engine.

Cancellation uses the SDK's supported task and query lifecycle APIs. The inert
protocol test proves the real SDK transport and real descendant termination for
that controlled process tree; it does not establish control over arbitrary
independently detached external daemons or exercise paid model behavior.

## Review evidence

The independent review challenged startup ownership across navigation, late
history, cancellation and same-session resumes. Regressions now cover each
identified race, including an old start request received after a later engine
has resumed the same conversation. The installed SDK cancellation checks and
receipt observer were also independently rerun.

| Finding | Regression evidence |
| --- | --- |
| RR-1 | `src/server/startup.test.ts`, `test/browser/startup.tsx`: four server cases and ten actual Chrome scenarios |
| RR-2 | `src/server/stop-work.test.ts`, `src/web/lib/stop-work.test.ts`: SDK subprocess/worker exits, account boundary, resume fencing and mounted composer controls |
| REL-1 service observer | `src/server/commit-receipt.test.ts`: both CLI formats, invalid/non-live controls and real tool-result pump |
