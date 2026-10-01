# Getting started

FlupCode runs on the **OpenCode 2** engine and starts it for you. This page is the shortest path
from a clean machine to a working session, plus the mistakes that most often block first-time users.

## What you need

1. Nothing to install for the engine. The desktop app and the `flupcode` command fetch the pinned
   OpenCode 2 once, check it against its published integrity, and keep it in FlupCode's cache. They
   never use or replace the `opencode` on your PATH.
2. A model provider ([Providers](https://opencode.ai/docs/providers/)), connected from
   **Settings → Providers**. Without one, the model selector is empty and prompts fail.

You only need Bun 1.3+ if you run FlupCode [from source](#from-source).

## Pick a path

| I want to…           | Start the engine with                | Open FlupCode                                                         |
| -------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| Use an installed app | the app itself                       | [Desktop release](https://github.com/rldona/FlupCode/releases/latest) |
| Use it in a browser  | the desktop app, or `flupcode serve` | [app.flupcode.com](https://app.flupcode.com)                          |
| Run from source      | the desktop app, or `flupcode serve` | `bun run dev:harness`, then `http://localhost:4444`                   |

## The desktop app

Install it from the [latest release](https://github.com/rldona/FlupCode/releases/latest) and open
it. It starts OpenCode 2 with its own password and its own database, and signs in for you. While it
is open, **the web app works too**: the desktop answers at `http://127.0.0.1:4096` for
app.flupcode.com and `localhost:4444` and signs them in.

## The web app without the desktop: `flupcode serve`

Install the `flupcode` binary for your platform from the
[latest release](https://github.com/rldona/FlupCode/releases/latest) (see
[USAGE.md](USAGE.md#from-a-terminal-flupcode-remote)), then **leave this running**:

```bash
flupcode serve
```

It starts OpenCode 2 on a private port and answers at `http://127.0.0.1:4096`. OpenCode 2 always
asks for a password and a browser page cannot send one, so `flupcode serve` signs in for the page.
It does that only for FlupCode's own pages (app.flupcode.com and `localhost:4444`; add others with
`FLUPCODE_WEB_ORIGINS`). Any other page open in your browser is refused, which is what the password
was protecting. Then open [app.flupcode.com](https://app.flupcode.com). It connects to
`http://localhost:4096`; change the address in **Settings → Server** if you passed `--port`.

To have it whenever you log in, with nothing to start, install it as a login service (a launchd
agent on macOS, a systemd user unit on Linux):

```bash
flupcode serve --install
```

It restarts when it stops, and waits while the desktop app holds the port. If you open the desktop
app while it runs, the desktop uses this engine. `flupcode serve --uninstall` removes it.

## Your OpenCode 1.x history

FlupCode's OpenCode 2 keeps its own database, so your 1.x sessions stay where they are until you
import them. Use File → _Import OpenCode 1.x History…_ in the desktop, or `flupcode engine import-v1`.
Both can be undone. See [OPENCODE-2.md](OPENCODE-2.md).

## From source

```bash
bun install
bun run dev:harness   # the web app at http://localhost:4444
```

For the engine, keep the desktop app open, or run `bun packages/flupcode-cli/src/index.ts serve`.

## OpenCode 1.x (deprecated)

`FLUPCODE_ENGINE=v1` makes the desktop app and `flupcode remote` start the `opencode` on your PATH as
before. To use a 1.x engine from the web app directly, start it without a password and with the
page's origin allowed:

```bash
env -u OPENCODE_SERVER_PASSWORD opencode serve --port 4096 --cors https://app.flupcode.com
```

Support for 1.x is removed in a coming release.

## Troubleshooting

FlupCode tells two failures apart on purpose:

- **"Sin conexión al servidor" / Server offline** means nothing answered.
- **"Conexión bloqueada por el navegador" / Connection blocked by the browser** means something is
  listening, but the browser refused to hand the response to the page.

| Symptom                                     | Cause                                                                           | Fix                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| "Server offline"                            | Neither the desktop app nor `flupcode serve` is running, or the port is wrong   | Start one of them; check the address in Settings                        |
| "This engine is OpenCode 2…" in the web app | An OpenCode 2 started some other way: it wants a password the page cannot send  | Stop it and use `flupcode serve` or the desktop app                     |
| `403` from `127.0.0.1:4096`                 | The page is not FlupCode's web app                                              | Add its origin to `FLUPCODE_WEB_ORIGINS`                                |
| Nothing connects on **Safari**              | WebKit blocks `https://` pages from reaching `http://localhost` (mixed content) | Use the **desktop app**, which is not subject to the mixed-content rule |
| Chrome shows a Local Network Access prompt  | Chromium gates requests from public pages to loopback                           | Allow it; FlupCode answers that preflight                               |
| Empty model selector                        | No provider connected                                                           | Connect one in **Settings → Providers**                                 |
| "FlupCode Not Opened" / SmartScreen         | Builds are not signed yet                                                       | See [Installing a release](USAGE.md#installing-a-release)               |

### Why Safari needs the desktop app

Safari does not apply the loopback exception to the mixed-content rule, so an `https://` page is
**not allowed** to call `http://localhost`. Chromium and Firefox allow it. The desktop app loads its
window locally, so the rule never applies.
