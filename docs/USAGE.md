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

### Installing a release

Download `FlupCode-mac-arm64.dmg` (Apple Silicon), `FlupCode-mac-x64.dmg`, `FlupCode-win-x64.exe` or
`FlupCode-linux-x64.AppImage` from the [latest release](https://github.com/rldona/FlupCode/releases/latest).
The app checks for updates on start and every 6 hours, downloads them and offers **Restart now**
(or installs on quit). On macOS, while builds are unsigned, FlupCode replaces its own bundle after
quitting (Squirrel.Mac rejects unsigned updates); it needs the app in a folder you can write to,
such as Applications. Versions up to 1.0.13 cannot install updates on macOS: install 1.0.14 by hand
once.

Builds are **not signed or notarized** yet (F5-4). The first time you open the app on macOS it shows
"FlupCode Not Opened" ("No se ha abierto FlupCode"). Do not move it to the Bin; click **Done**, then
either:

- open **System Settings → Privacy & Security**, scroll to the FlupCode notice and click
  **Open Anyway**, or
- remove the quarantine flag and open it again:

  ```bash
  xattr -dr com.apple.quarantine /Applications/FlupCode.app
  ```

An update may bring the prompt back; repeat the same step. On Windows, SmartScreen shows "Windows
protected your PC": click **More info → Run anyway**.

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

Drive your computer's sessions from a phone, on any network, like Claude Code's remote control.
The desktop app (1.0.10 or later) connects out to a relay and the phone talks to it through that
relay; everything is end-to-end encrypted, so the relay cannot read your sessions (ADR-0010).

1. In the desktop app, open **Remote control** (sidebar menu, Settings or the command palette) and
   turn **Allow remote control** on. Wait for **Online**.
2. Click **Pair a device** and scan the QR code with the phone's camera. Open the link **in your
   browser** (in Google Lens, use ⋮ → *Open in Chrome*): pairing is stored in the browser that opens
   it. The code works once and expires after 10 minutes. **Copy link** sends it another way.
3. The phone opens FlupCode (`https://app.flupcode.com`) and pairs. It shows the phone view:
   - **Code** (home): your paired computers with their state, **Add device**, and your sessions
     with their state (working, needs your input, idle), `project · branch` and last activity,
     filtered by All / Active.
   - Tap a session to follow it, answer permission requests or send prompts; ← returns home.
   - **New session** asks for a project and starts a session there.

   The app always opens on the home. To use it as an app, install it from Chrome (⋮ → *Install
   app* / *Add to Home screen*) or Safari (Share → *Add to Home Screen*).

### Notifications

On the phone, tap **Turn on** under **Get notified** (home) or in **Remote control**. The phone is
then notified — also with the app closed and the screen locked — when a session needs your
permission, asks a question, finishes or stops with an error. Tap the notification to open that
session. **Turn off** stops them for that computer's phone.

- Notifications come from the computer while it is running with remote control on; a sleeping
  computer sends nothing.
- **iPhone/iPad**: add FlupCode to the Home Screen (Share → *Add to Home Screen*), open it from
  there, then turn notifications on. Safari tabs cannot receive them.
- Content is end-to-end encrypted: the relay and the push service cannot read it (ADR-0011).
- The desktop's **Paired devices** list and `flupcode remote`'s `d` show which devices have them on.

Paired phones reconnect on their own. Remove a phone from **Paired devices** on the computer to
revoke it immediately. The computer must stay awake with FlupCode open (or `flupcode remote`
running). A desktop browser that pairs keeps the full desktop layout.

The phone asks the browser to keep its data, so the pairing survives storage clean-ups; uninstalling
the installed app still erases it, and the phone then has to pair again. If the app ever fails to
start it shows the error with **Reload** and **Reset app data**, which clears saved app state but
keeps paired computers.

### From a terminal: `flupcode remote`

Without the desktop app — on a headless machine, over SSH, or if you live in the terminal — host
remote control with `flupcode remote` (like `claude remote-control`). Install the binary for your
platform from the [latest release](https://github.com/rldona/FlupCode/releases/latest)
(`flupcode-darwin-arm64`, `-darwin-x64`, `-linux-x64`, `-linux-arm64`, `-windows-x64.exe`). On a Mac
with Apple Silicon, into a directory on your `PATH`:

```bash
mkdir -p ~/.local/bin
curl -fL -o ~/.local/bin/flupcode https://github.com/rldona/FlupCode/releases/latest/download/flupcode-darwin-arm64
chmod +x ~/.local/bin/flupcode
flupcode remote
```

Downloaded with `curl` the binary is not quarantined; if you download it from a browser, run
`xattr -d com.apple.quarantine ~/.local/bin/flupcode` first.

It exposes the OpenCode server at `http://127.0.0.1:4096` (starting `opencode serve` if needed),
prints a QR code to scan, and keeps running until you type `q`. While it runs, type `p` for a new
pairing code, `d` to list devices and `r <n>` to remove one. `flupcode remote devices` and
`flupcode remote revoke <n>` work when it is stopped. The identity and paired devices live in
`~/.config/flupcode/remote.json` (readable only by you, not encrypted with the keychain). From the
repository, run `bun packages/flupcode-cli/src/index.ts remote`.

The terminal host has its own identity, separate from the desktop app: a phone paired with one
does not appear in the other, and the phone lists them as two computers. Do not run both hosts
against the same engine at the same time.

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
- **"FlupCode Not Opened" on macOS** — the build is unsigned; see
  [Installing a release](#installing-a-release).
- **Remote control stays "Connecting"** — check that the relay URL is reachable (`/health`) and uses
  `wss://`. On the phone, "The computer is offline" means the desktop app is closed, asleep or has
  remote control turned off.
- **The phone asks for my name or a server after scanning** — the QR link opened in another browser
  (for example Google Lens' built-in viewer), which stored the pairing there. Remove the device on
  the computer, create a new code and open the link in Chrome or Safari.
- **The phone shows the desktop layout** — it is still running an older version of the web app:
  reload the page, or close the tab and open `app.flupcode.com` again. Also turn off Chrome's
  *Desktop site*.
- **"The pairing code expired or was already used"** — codes work once for 10 minutes; create a new
  one on the computer.
- **No notifications arrive** — check they are on (home → **Notifications on**), that the phone
  allows notifications for the browser or the installed app, and that the computer is awake with
  remote control on. On iPhone they only work from the Home Screen app. A custom relay needs VAPID
  keys (see `packages/relay/README.md`).
- **"Notifications are blocked for this site"** — allow notifications for `app.flupcode.com` in the
  browser's site settings (Chrome: ⋮ → Settings → Site settings → Notifications).
- **The installed phone app still shows an old icon** — uninstall it and install it again; browsers
  keep the icon of an installed app.
- **The phone disconnected after I started another FlupCode** — two hosts with the same identity
  (for example a development build and the installed app) replace each other on the relay. Keep
  one running and toggle **Allow remote control** off and on.
