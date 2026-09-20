# Usage

How to run and use FlupCode.

## Requirements

- [Bun](https://bun.sh) 1.3+
- A configured model provider (see [Providers](https://opencode.ai/docs/providers/))

## Install

```bash
bun install
```

If your global `~/.npmrc` points at a private registry, force the public one:

```bash
npm_config_registry="https://registry.npmjs.org/" bun install --frozen-lockfile
```

## Run

### Web

```bash
# terminal 1 — engine
bun run --cwd packages/opencode src/index.ts serve --port 4096

# terminal 2 — harness
bun run dev:harness
```

Open http://localhost:4444. The server URL defaults to `http://localhost:4096`; edit it in the top
bar or set `VITE_OPENCODE_SERVER_URL`.

### Desktop

```bash
bun run dev:harness          # renderer
bun run dev:harness-desktop  # Electron window
```

The desktop main process starts a local server automatically if none is reachable. Set
`FLUPCODE_NO_SERVER=1` to disable that, or `FLUPCODE_DEV_URL` to point at another renderer.

## Layout

- **Sidebar** — New session, navigation (Artifacts, Routines, Personalize), projects with quick
  create and pinning, and the session list.
- **Canvas** — the usage dashboard on the home screen, or the conversation when a session is open.
- **Composer** — the input dock with attachments, voice, context chips, model/variant and Auto mode.

## Keyboard

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl+K` or `Cmd/Ctrl+P` | Command palette (commands, sessions, files) |
| `Enter` | Send |
| `Shift+Enter` | New line |
| `Esc` | Close dialogs / palette |

## Composer

- Type `/` to open the slash-command menu (built-ins, server commands and skills).
- Type `@` to search files and insert a reference.
- Start with `!` to run a shell command.
- Paste a large block of text to collapse it into `[Pasted ~N lines]`; it expands on send.
- Attach files with the `+` button, drag and drop, or paste an image.
- Use the **Voz** button for dictation where the browser supports the Web Speech API.
- **Guardar** stashes the current prompt; `/stashes` restores them.

Built-in commands: `/new`, `/compact`, `/steps`, `/mcp`, `/stash`, `/stashes`, `/settings`,
`/about`.

## Sessions

The session toolbar offers agent selection, Fork, Compact, Undo, Redo, Confirm revert, Rename,
Export Markdown, Move to another project and Delete. Subagents appear below the toolbar; the task
list appears above the composer.

## Usage dashboard

The home screen shows sessions, messages, tokens, active days, current and longest streaks, peak
hour and favorite model, with Todo / 30d / 7d ranges, a Models tab and a one-year activity heatmap.

## MCP

Open **Personalize → Servers MCP** or run `/mcp` to list, connect, disconnect, add and remove MCP
servers.

## Remote / mobile

Serve the engine on your LAN and open the harness from a phone:

```bash
OPENCODE_SERVER_PASSWORD=secret bun run --cwd packages/opencode src/index.ts serve \
  --hostname 0.0.0.0 --port 4096
```

Open `http://<your-computer>:4096` on the phone (the engine serves the built web UI), or point a
harness instance at it. Always set a password when exposing the server.

## Troubleshooting

- **Install fails with 401 / private registry** — force the public registry as shown above.
- **"Sin conexión" in the top bar** — check the server URL and that `opencode serve` is running.
- **Empty model selector** — connect a provider or leave **Auto** enabled to use the server default.
