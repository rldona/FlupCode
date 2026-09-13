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

Open http://localhost:4444. The server URL defaults to `http://localhost:4096`; change it in
**Settings → Server**, or set `VITE_OPENCODE_SERVER_URL`.

### Hosted web app

There is a deployed UI at https://app.flupcode.com that talks to an engine on your machine. Install
the OpenCode CLI first (instructions per platform at https://opencode.ai/docs/), then start it with
CORS enabled for the hosted origin:

```bash
opencode serve --port 4096 --cors https://app.flupcode.com
```

The `--cors` origin is required because the page and the engine are different origins. The app
connects to `http://localhost:4096` by default (change it in **Settings → Server**).

> **Engine patches.** The published OpenCode CLI tracks upstream and does not include FlupCode's
> core patches (GitHub Copilot OAuth in the v2 catalog, session permission modes). For those, run
> the engine from this fork's source instead:
>
> ```bash
> OPENCODE_DISABLE_CHANNEL_DB=1 bun run --cwd packages/opencode src/index.ts serve \
>   --port 4096 --cors https://app.flupcode.com
> ```

### Desktop

```bash
bun run dev:harness          # renderer
bun run dev:harness-desktop  # Electron window
```

The desktop main process starts a local server automatically if none is reachable. Set
`FLUPCODE_NO_SERVER=1` to disable that, or `FLUPCODE_DEV_URL` to point at another renderer.

Downloaded builds are unsigned. On macOS, if the app reports it is “damaged”, remove the
quarantine flag and open again:

```bash
xattr -dr com.apple.quarantine /Applications/FlupCode.app
```

## Layout

- **Sidebar** — New session, navigation (Artifacts, Routines, Personalize), projects with quick
  create and pinning, and the session list.
- **Canvas** — the usage dashboard on the home screen, or the conversation when a session is open.
- **Composer** — the input dock with attachments, voice, context chips, model/effort and permission modes.

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

## See your existing OpenCode (TUI) sessions

FlupCode is a client: it shows the sessions of the server it connects to. The TUI and FlupCode
share sessions when they use the same server **and** the same database.

OpenCode picks its database by installation channel:

- The installed `opencode` (release) uses `~/.local/share/opencode/opencode.db`.
- A local development server uses `~/.local/share/opencode/opencode-local.db`.

So a dev server started with the plain command will **not** show your TUI sessions. To make FlupCode
read the same database as your installed OpenCode, start the engine with the channel DB disabled
(or point `OPENCODE_DB` at the file):

```bash
OPENCODE_DISABLE_CHANNEL_DB=1 bun run --cwd packages/opencode src/index.ts serve --port 4096
```

Then reload FlupCode: the sidebar will list every project and session.

Alternatively, keep FlupCode's server and attach the TUI to it, so both share that server:

```bash
opencode attach http://localhost:4096
```

## Remote control

Drive your computer's sessions from a phone, on any network. The desktop app connects out to a
relay and the phone talks to it through that relay; everything is end-to-end encrypted, so the
relay cannot read your sessions (ADR-0010).

1. In the desktop app, open **Remote control** (sidebar menu, Settings or the command palette) and
   turn **Allow remote control** on. Wait for **Online**.
2. Click **Pair a device** and scan the QR code with the phone's camera. The code works once and
   expires after 10 minutes.
3. The phone opens FlupCode (`https://app.flupcode.com`), pairs and connects. A **Remote: <computer>**
   badge in the top bar shows the connection; tap it to disconnect or switch computers. Add the
   page to the home screen to use it as an app.

Paired phones reconnect on their own. Remove a phone from **Paired devices** on the computer to
revoke it immediately. The computer must stay awake with FlupCode open.

### Self-hosting the relay

The desktop app uses `wss://relay.flupcode.com` by default. To use your own relay, deploy
`packages/relay` (see its README) and set it under **Remote control → Advanced → Relay**, or start
the app with `FLUPCODE_RELAY_URL`. Set `FLUPCODE_APP_URL` if you host the web app elsewhere.

### Developing remote control

```bash
bun run --cwd packages/relay dev
bun packages/remote/script/dev-host.ts --relay ws://localhost:8787 --app http://localhost:4444/
```

The second command is a headless host (no Electron) that tunnels to the engine on `:4096` and
prints a pairing link. Open it in a browser on `localhost`: remote control needs a secure context,
so a phone must load the app over HTTPS.

### Local network without a relay

Serve the engine on your LAN and open the harness from a phone:

```bash
OPENCODE_SERVER_PASSWORD=secret bun run --cwd packages/opencode src/index.ts serve \
  --hostname 0.0.0.0 --port 4096
```

Point a harness instance at `http://<your-computer>:4096`. Always set a password when exposing the
server.

## Troubleshooting

- **Install fails with 401 / private registry** — force the public registry as shown above.
- **"Sin conexión" in the top bar** — check the server URL and that `opencode serve` is running.
- **Empty model selector** — connect a provider or leave **Auto** enabled to use the server default.
- **Remote control stays "Connecting"** — check that the relay URL is reachable (`/health`) and uses
  `wss://`. On the phone, "The computer is offline" means the desktop app is closed, asleep or has
  remote control turned off.
