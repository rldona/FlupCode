<p align="center">
  <a href="https://flupcode.com"><img src="assets/flupcode-tentative-logo.png" alt="FlupCode" width="180" /></a>
</p>

<p align="center">
  Web and desktop harness for OpenCode — a project sidebar, usage dashboard, runs, workflows,
  artifacts and routines, with a polished composer.
</p>

<p align="center">
  <a href="https://github.com/rldona/FlupCode/actions/workflows/harness.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/rldona/FlupCode/harness.yml?branch=power&label=build" /></a>
  <a href="https://github.com/rldona/FlupCode/releases"><img alt="release" src="https://img.shields.io/github/v/release/rldona/FlupCode?label=release" /></a>
  <a href="https://github.com/rldona/FlupCode/blob/power/LICENSE"><img alt="license" src="https://img.shields.io/github/license/rldona/FlupCode?label=license" /></a>
  <a href="https://flupcode.com"><img alt="website" src="https://img.shields.io/badge/website-flupcode.com-9aa84f" /></a>
</p>

<p align="center">
  <img alt="platforms" src="https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" />
  <a href="https://github.com/rldona/FlupCode/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/rldona/FlupCode" /></a>
  <a href="https://github.com/rldona/FlupCode/issues"><img alt="issues" src="https://img.shields.io/github/issues/rldona/FlupCode" /></a>
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen" />
  <img alt="fork of OpenCode" src="https://img.shields.io/badge/fork%20of-OpenCode-blueviolet" />
</p>

<p align="center">
  <img src="docs/assets/flupcode-cover-new.png" alt="FlupCode — the web and desktop harness for OpenCode" width="920" />
</p>

---

### Contents

- [Why a fork](#why-a-fork)
- [Highlights](#highlights)
- [Status](#status)
- [Repository layout](#repository-layout)
- [Install](#install)
- [Development](#development)
- [Web app](#web-app)
- [Documentation](#documentation)
- [License](#license)

🌐 **Website:** [flupcode.com](https://flupcode.com) · 🖥️ **Web app:** [app.flupcode.com](https://app.flupcode.com) · 💻 **Source:** [rldona/FlupCode](https://github.com/rldona/FlupCode) · ⬇️ **[Download](https://github.com/rldona/FlupCode/releases/latest)**

FlupCode is a fork of [OpenCode](https://github.com/anomalyco/opencode) that takes its
terminal-grade feature set and packages it into a first-class **web and desktop experience**:
a harness layout with a project sidebar, usage dashboard, runs, workflows, artifacts, routines and a
polished composer — modelled on the Anthropic Claude Code desktop app.

> **Runs on OpenCode 2, with nothing to install for it.** The desktop app and the `flupcode` command
> fetch the pinned OpenCode 2 engine once, check it against its published integrity, and start it.
> The web app connects to one of them: the desktop app while it is open, or `flupcode serve`. See
> [docs/OPENCODE-2.md](docs/OPENCODE-2.md).

> **Not affiliated with OpenCode or Anthropic.** FlupCode is an independent fork. "OpenCode"
> is the upstream project by [Anomaly](https://anoma.ly), and "Claude Code" is a product of
> Anthropic. This fork is not built by, endorsed by, or affiliated with either of them.

## Why a fork

OpenCode is already a client/server system: `opencode serve` exposes an HTTP + SSE API and every
front-end (terminal TUI, web app, desktop app, IDE plugins) is just a client. FlupCode reuses
that engine untouched and focuses entirely on the **experience layer** — the shell, the design
system and the harness features that OpenCode's default UI does not emphasise.

## Highlights

- **The official engine.** FlupCode runs the official OpenCode 2 binary at a pinned version and
  extends it through plugins, never through patches
  ([ADR-0027](docs/adr/0027-official-opencode-binary.md)).
- **Isolated product code.** Everything we build lives in `packages/harness` (web) and
  `packages/harness-desktop` (desktop), reusing `@opencode-ai/ui`, `@opencode-ai/session-ui`
  and the generated client/SDK.
- **Upstream by version.** A weekly pull request moves the pin to the newest OpenCode 2 release
  once it is three days old, and the engine suite and the live e2e judge it. See
  [docs/UPSTREAM.md](docs/UPSTREAM.md).
- **Full TUI parity.** Feature-for-feature mapping of the terminal UI to the web UI is tracked in
  [docs/PARITY.md](docs/PARITY.md).
- **Harness features.** Usage dashboard, activity heatmap, multi-project workspaces, pinned
  items, artifacts and routines — see [docs/ROADMAP.md](docs/ROADMAP.md).
- **Runs that outlive the window.** A harness server of its own keeps runs, tasks, routines and
  artifacts: workflows written down as editable files and launched with `/feature …`, checks the
  harness runs itself with the evidence kept, bounded retries when one fails, and human gates that
  hold a run until you let it through — see [docs/USAGE.md](docs/USAGE.md#runs).
- **Remote control.** Drive your computer's sessions from your phone on any network, like Claude
  Code's remote control: pair with a QR code, follow and start sessions, answer permission requests.
  Traffic is end-to-end encrypted through a relay that cannot read it. Host it from the desktop app
  or from a terminal with `flupcode remote` — see [docs/USAGE.md](docs/USAGE.md#remote-control) and
  [ADR-0010](docs/adr/0010-remote-control-relay.md).

## Status

**v1.15.0.** The web harness (Claude Code–style shell, TUI parity, dashboard, i18n), the Electron
desktop app and remote control (relay at `relay.flupcode.com`, phone view, `flupcode remote`) are
released, along with the harness server that owns runs: tasks, routines with history, verification
with evidence, workflows with human gates, and artifacts — now including the **documents the agent
generates** (kept in `.flupcode/artifacts` with the `artifact_write` tool, listed under Artifacts and
read by type: markdown, HTML, image, PDF). Editors for routines, agents and skills open in dialogs,
and Compare runs inside the chat layout. The upstream sync and release pipelines are in place.
Desktop builds are not yet signed by Apple or Microsoft (see [Install](#install)). See
[docs/ROADMAP.md](docs/ROADMAP.md) for the live status.

## Repository layout

```
packages/harness              # FlupCode web app (SolidJS + Vite) — our product code
packages/harness-desktop      # Electron desktop app (also hosts remote control)
packages/remote               # remote control protocol and host (shared by desktop, CLI, web)
packages/relay                # remote control relay server (Bun, deployed on Fly.io)
packages/flupcode-cli         # the `flupcode` command (`remote`, `serve`, `engine`)
packages/landing              # flupcode.com static site
packages/app                  # upstream OpenCode web app (pristine, reused for parts)
packages/tui                  # upstream terminal UI (pristine)
packages/ui                   # upstream shared UI primitives (reused)
packages/session-ui           # upstream session/message rendering (reused)
packages/core | server | sdk  # upstream engine (pristine)
docs/                         # project documentation (this fork)
```

## Install

Download the desktop app and the `flupcode` CLI from the
[latest release](https://github.com/rldona/FlupCode/releases/latest):

| Platform | Desktop app | CLI |
| --- | --- | --- |
| macOS (Apple Silicon) | `FlupCode-mac-arm64.dmg` | `flupcode-darwin-arm64` |
| macOS (Intel) | `FlupCode-mac-x64.dmg` | `flupcode-darwin-x64` |
| Windows | `FlupCode-win-x64.exe` | `flupcode-windows-x64.exe` |
| Linux | `FlupCode-linux-x64.AppImage`, `FlupCode-linux-x64.deb`, `FlupCode-linux-x64.rpm` | `flupcode-linux-x64`, `flupcode-linux-arm64` |

The builds are **not signed** yet, so macOS shows "FlupCode Not Opened" / "No se ha abierto
FlupCode" and Windows shows SmartScreen. On macOS, click **Done**, then open **System Settings →
Privacy & Security** and click **Open Anyway** — or run
`xattr -dr com.apple.quarantine /Applications/FlupCode.app`. Details in
[docs/USAGE.md](docs/USAGE.md#installing-a-release).

## Development

Requirements: [Bun](https://bun.sh) 1.3+.

```bash
bun install
bun run dev:harness      # start the FlupCode web app
bun run dev:web          # start the upstream web app (reference)
bun run dev:desktop      # start the upstream desktop app (reference)
```

> **Corporate registry note.** If your global `~/.npmrc` points at a private registry, force the
> public registry for installs:
> `npm_config_registry="https://registry.npmjs.org/" bun install --frozen-lockfile`

## Web app

Use the hosted UI at [app.flupcode.com](https://app.flupcode.com). It connects to OpenCode 2 on your
machine at `http://localhost:4096`, which either of these provides:

- **The desktop app, while it is open.** It serves the web app too, with the same engine and
  sessions.
- **`flupcode serve`, without the desktop.** It starts the pinned OpenCode 2 and leaves it running:

  ```bash
  flupcode serve             # until Ctrl-C
  flupcode serve --install   # at every login (macOS launchd, Linux systemd); --uninstall removes it
  ```

OpenCode 2 always asks for a password, and a web page cannot send one. So both sign in for the page,
and only for FlupCode's own pages: app.flupcode.com and `localhost:4444`, plus any you add with
`FLUPCODE_WEB_ORIGINS`. Every other page open in your browser is refused. Change the address in
**Settings → Server** if you use another port.

Controlling a computer from your phone needs none of this. The computer runs the desktop app (or
`flupcode remote`) and the phone pairs once; see [docs/USAGE.md](docs/USAGE.md#remote-control).

OpenCode 1.x is no longer supported. Your 1.x history can be imported; see
[docs/OPENCODE-2.md](docs/OPENCODE-2.md).

## Documentation

| Document | Purpose |
| --- | --- |
| [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) | First run: the desktop app, the web app with `flupcode serve`, and fixing a blocked connection |
| [docs/OPENCODE-2.md](docs/OPENCODE-2.md) | FlupCode on OpenCode 2: what changed, importing 1.x history, staying on 1.x for now |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the monorepo fits together and where FlupCode lives |
| [docs/USAGE.md](docs/USAGE.md) | Install, run, keyboard shortcuts and troubleshooting |
| [docs/UPSTREAM.md](docs/UPSTREAM.md) | Following OpenCode: the pin and the old fork sync |
| [docs/DESIGN.md](docs/DESIGN.md) | Design system and the Claude Code–style harness direction |
| [docs/PARITY.md](docs/PARITY.md) | TUI ↔ Web feature parity matrix |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Prioritised, ticket-based roadmap |
| [docs/COMMUNITY-FEATURES.md](docs/COMMUNITY-FEATURES.md) | Community-requested OpenCode features prioritised for FlupCode |
| [docs/RELEASE.md](docs/RELEASE.md) | Versioning and release process |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | Language, conventions, workflow |
| [docs/adr/](docs/adr/) | Architecture Decision Records |
| [docs/tickets/](docs/tickets/) | Per-phase ticket breakdowns |

## License

MIT, inherited from OpenCode. See [LICENSE](LICENSE). Upstream copyright and attribution are
preserved.
