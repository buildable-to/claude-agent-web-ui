# claude-agent-web-ui

Browser front end for Claude Code, built on `@anthropic-ai/claude-agent-sdk`.
Node server (Express + ws) drives one SDK `query()` per chat and streams
everything to a React page over a WebSocket. See README.md for the user view.

## Commands

- `npm run dev` — API server (tsx watch, :3456) + Vite (:5173, proxies /api and /ws)
- `npm run typecheck` — both tsconfigs (web + server)
- `npm run build` — Vite bundle to dist/web, server to dist/server
- `npm start -- --dir <project>` — production, one port

## Layout

- `src/shared/protocol.ts` — the only file both sides import. Change the wire
  protocol here first.
- `src/server/live-session.ts` — one engine process. `canUseTool` turns
  into a `permission_request` the browser answers. Buffers non-stream messages
  for replay on attach.
- `src/server/session-manager.ts` — uses the SDK's own session store
  (`listSessions`, `getSessionMessages`, ...), so terminal sessions appear too.
- `src/web/lib/transcript.ts` — pure reducer from SDK messages to turns.
  Stream events build blocks; the later complete `assistant` message replaces
  the streamed block in order. Tool results attach by `tool_use_id`.
- `src/web/state/useSession.ts` — engine starts lazily on first send
  (`start`), otherwise the page only attaches to already-running sessions.
- `src/web/components/ActivityGroup.tsx` — a run of tool calls/thinking as
  chips that expand into a timeline; auto-opens while the turn is live.
- `src/web/components/FileTree.tsx` + `src/server/tree.ts` — project files
  panel (`GET /api/tree`), refreshed after every turn.
- Theme: Buildable's precision-dark CAD look, dark only. Tokens in
  `src/web/index.css` mirror `buildable/static/css/_variables.css` in the
  ezdxf-flask repo (DM Sans / Archivo / JetBrains Mono, blue accent). The
  favicon and top-bar mark are generated from Buildable's print logo.

## Things that bit us

- The SDK does not use Claude Code's system prompt unless you pass
  `systemPrompt: { type: 'preset', preset: 'claude_code' }`. Without it the
  model doesn't know the cwd.
- `settingSources: ['user','project','local']` is what makes CLAUDE.md files
  and existing allow rules apply.
- The engine does not echo user messages back; the client adds them locally
  and dedupes by uuid.
- Read-only shell commands (`echo`, `ls`, `pwd`) are auto-allowed by Claude
  Code itself; test permission flows with a Write or a file-changing command.
- Browser automation: the automation tab can report `visibilityState: hidden`,
  in which case screenshots time out even though the page works. Verify with
  `javascript_tool` / page text instead.

## Conventions

- Commit after each meaningful step.
- Tool card components under `src/web/components/tools/` are adapted from
  ninehills/claude-agent-ui (MIT); keep `LICENSE-ninehills.txt` next to them.
