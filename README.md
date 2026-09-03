# Claude Agent Web UI

Claude Code, driven from a browser tab instead of a terminal. Same engine, same
tools, same permissions. This adds the screen around it: a streaming chat,
collapsible cards for every file read, edit and command, an approval banner
for anything Claude isn't already allowed to do, and a session list that
shares Claude Code's own history (sessions you started in the terminal show up
here too).

Built on the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview),
which ships the Claude Code engine as an npm package.

## Requirements

- Node 20 or newer
- A Claude Code login on this machine (`claude` in the terminal works), or
  `ANTHROPIC_API_KEY` in the environment

## Run it

```bash
npm install
npm run dev            # API server on :3456 + Vite dev server on :5173
```

Open <http://localhost:5173>. By default the agent works in the directory you
started the server from. Point it somewhere else:

```bash
npm run dev -- --dir /path/to/project
```

Production build, served from one port:

```bash
npm run build
npm start -- --dir /path/to/project --port 3456
```

Flags and environment variables:

| Flag       | Env           | Default       |
| ---------- | ------------- | ------------- |
| `--dir`    | `PROJECT_DIR` | current dir   |
| `--port`   | `PORT`        | `3456`        |
| `--host`   | `HOST`        | `127.0.0.1`   |

## How permissions work

The engine runs in Claude Code's normal `default` mode with your user, project
and local settings loaded, so existing allow rules and `CLAUDE.md` files apply.
When Claude wants to do something that isn't pre-approved, the terminal would
print a question and wait for a key. Here the question is pushed to the browser
as an amber banner with **Approve**, **Deny** and, where the engine offers it,
**Always allow** (the same as "don't ask again" in the terminal). Reads are
allowed without asking, like in the terminal.

The permission mode can be changed per session from the top bar. "Bypass all"
never asks; use it only for throwaway work.

## Skills

Type `/` in the composer (or click **Skills**) to pick from the slash commands
and skills the engine knows for this project: built-ins, your `.claude`
commands and skills, and plugin skills. The list comes from the engine itself
(`GET /api/commands` spawns it briefly the first time, then caches).

## Security

This is a shell with a web page in front of it. The server binds to
`127.0.0.1` and has no login. Do not expose it to a network without putting
authentication and HTTPS in front of it.

## How it's put together

```
src/shared/protocol.ts   wire protocol between browser and server
src/server/              Node + Express + ws
  live-session.ts        one engine process (Agent SDK query) and its permission queue
  session-manager.ts     start / resume / list / rename / delete sessions
  ws.ts                  WebSocket handler
  index.ts               REST routes + static hosting
src/web/                 React + Vite + Tailwind
  lib/transcript.ts      SDK message stream -> turns, blocks, tool results
  state/useSession.ts    one chat: history, attach, send, approve, interrupt
  components/            chat, tool cards, permission banner, sidebar, top bar
```

An engine process starts only when you send the first message of a session
(new or resumed) and is kept alive while the chat is open, so follow-ups are
fast. Idle engines are closed after an hour.

## Look

The UI uses Buildable's own dark CAD theme (same tokens, fonts and mark as the
studio in the ezdxf-flask repo), since it replaces Buildable's in-app agent.

## Credits

Tool card components are adapted from
[ninehills/claude-agent-ui](https://github.com/ninehills/claude-agent-ui) (MIT).
