# Getting started

FlupCode is a **client**. It does not ship the OpenCode engine, so nothing runs until one is
reachable. This page is the shortest path from a clean machine to a working session, and the
mistakes that block first-time users.

## What you need

1. The **OpenCode CLI** (the engine). FlupCode talks to it over HTTP + SSE.
2. A model provider configured for OpenCode ([Providers](https://opencode.ai/docs/providers/)).
   Without one the model selector is empty and prompts fail.

Bun 1.3+ is only needed if you run FlupCode [from source](#from-source).

## Pick a path

| I want to…           | Engine             | FlupCode                                                              |
| -------------------- | ------------------ | --------------------------------------------------------------------- |
| Use an installed app | Started by the app | [Desktop release](https://github.com/rldona/FlupCode/releases/latest) |
| Use it in a browser  | You start it       | [app.flupcode.com](https://app.flupcode.com)                          |
| Run from source      | You start it       | `bun run dev:harness`                                                 |

## Step 1 — Install the engine

```bash
curl -fsSL https://opencode.ai/install | bash
```

Or pick your platform:

| Platform                 | Command                               |
| ------------------------ | ------------------------------------- |
| macOS / Linux (Homebrew) | `brew install anomalyco/tap/opencode` |
| npm / Bun / pnpm         | `npm install -g opencode-ai`          |
| Windows (Chocolatey)     | `choco install opencode`              |
| Windows (Scoop)          | `scoop install opencode`              |
| Arch Linux               | `sudo pacman -S opencode`             |

Windows works best under [WSL](https://opencode.ai/docs/windows-wsl). The full list lives at
[opencode.ai/docs](https://opencode.ai/docs/).

Verify it and make sure the binary is on your `PATH` (open a new terminal after installing):

```bash
opencode --version
```

If the command is not found, the shell has not picked up the install directory yet. FlupCode
reports the engine as missing until it can find `opencode`.

## Step 2 — Start the engine

**Desktop:** skip this. The app looks for `FLUPCODE_OPENCODE`, then an engine in the source
checkout, then `opencode` on the `PATH`, and starts one. If none is found it shows an install
prompt. Set `FLUPCODE_OPENCODE` to point at a specific binary, or `FLUPCODE_SERVER_URL` to attach
to an engine already running elsewhere.

**Hosted web app:** start it yourself, with the hosted origin allowed, and **leave it running**:

```bash
opencode serve --port 4096 --cors https://app.flupcode.com
```

`--cors` is required because the page (`https://app.flupcode.com`) and the engine
(`http://localhost:4096`) are different origins. Closing the terminal stops the engine and the tab
goes back to "offline".

**From source** (gets FlupCode's engine patches — GitHub Copilot OAuth, permission modes):

```bash
bun install
OPENCODE_DISABLE_CHANNEL_DB=1 bun run --cwd packages/opencode src/index.ts serve \
  --port 4096 --cors https://app.flupcode.com
```

`OPENCODE_DISABLE_CHANNEL_DB=1` makes the engine read the same database as an installed OpenCode,
so your TUI sessions appear in FlupCode. See [USAGE.md](USAGE.md#see-your-existing-opencode-tui-sessions).

## Step 3 — Open FlupCode

- Desktop: launch the app; it connects to `http://127.0.0.1:4096`.
- Web: open [app.flupcode.com](https://app.flupcode.com); it connects to `http://localhost:4096`.
- Source: open `http://localhost:4444`.

Change the server URL in **Settings → Server** if the engine runs on another port or host. The
onboarding modal shows the exact command for the page's origin.

## Troubleshooting

FlupCode tells the two apart on purpose: **"Sin conexión al servidor" / Server offline** means
nothing answered; **"Conexión bloqueada por el navegador" / Connection blocked by the browser**
means the engine is listening but the browser refused to hand the response to the page.

| Symptom                                    | Cause                                                                           | Fix                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| "Server offline"                           | No engine is running, or the port is wrong                                      | Start `opencode serve`, check the server URL in Settings                                   |
| "Connection blocked by the browser"        | The engine was started without `--cors` for this origin                         | Stop it and start it again with `--cors <page origin>`                                     |
| Nothing connects on **Safari**             | WebKit blocks `https://` pages from reaching `http://localhost` (mixed content) | Use the **desktop app**, which is not subject to the mixed-content rule                    |
| Chrome shows a Local Network Access prompt | Chromium gates public→loopback requests                                         | Allow it; FlupCode's engine answers the preflight once it is granted                       |
| Empty model selector                       | No provider connected                                                           | Connect one in OpenCode, or leave **Auto** enabled                                         |
| The sidebar does not list TUI sessions     | The dev engine uses a different database                                        | Start the engine with `OPENCODE_DISABLE_CHANNEL_DB=1`                                      |
| FlupCode warns "stock OpenCode engine"     | The engine is the published CLI, without FlupCode's patches                     | Run the engine from this fork's source (see [Start the engine](#step-2--start-the-engine)) |
| "FlupCode Not Opened" / SmartScreen        | Builds are not signed yet                                                       | See [Installing a release](USAGE.md#installing-a-release)                                  |

### Why Safari needs the desktop app

Safari does not apply the loopback exception to the mixed-content rule, so an `https://` page is
**not allowed** to call `http://localhost`. Chromium and Firefox allow it. FlupCode annotates its
requests as loopback and the engine opts in to Chromium's Local Network Access, but neither
convinces Safari. The desktop app loads its renderer locally, so the rule never applies.

### The engine is running but still blocked

The most common cause is an engine started **without** `--cors`. If you already have
`opencode serve --port 4096` running, stop it (`Ctrl+C`) and start it again with the origin:

```bash
opencode serve --port 4096 --cors https://app.flupcode.com
```

Then press **Retry** or reconnect in FlupCode. A preflight from the same origin should answer `204`
with `access-control-allow-origin`:

```bash
curl -i -X OPTIONS http://localhost:4096/global/health \
  -H "Origin: https://app.flupcode.com" -H "Access-Control-Request-Method: GET"
```
