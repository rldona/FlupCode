# ADR-0015: Web actions and browser automation

- **Status:** Proposed
- **Date:** 2026-09-24
- **Related:** ADR-0001 / ADR-0002 (fork boundary), ADR-0008 (language and conventions), ADR-0010 (remote control), F5-4 (desktop signing, blocked)

## Context

FlupCode is a client of the OpenCode engine and keeps the upstream packages read-only
(ADR-0001 / ADR-0002). Everything we build lives in `packages/harness`,
`packages/harness-desktop`, `packages/harness-server`, `packages/remote`, `packages/relay` and
`packages/flupcode-cli`.

The engine already runs arbitrary commands on the user's machine: the `bash` tool and a full PTY
API (`packages/protocol/src/groups/pty.ts`, `packages/core/src/pty`). The product already proves the
configuration seam: **delivery profiles** declared under `flupcode.delivery` (`docs/CONFIGURATION.md`)
make an installed engine plugin register one tool per profile, with `composeTools`, `labels` and
product-owned `guards`. A new product needs configuration alone; no repository file names a product.

What does not exist is any way for the agent to drive a **real browser** on the user's own machine:
there is no Playwright/Puppeteer, no OS input synthesis, no screen capture, and the in-app "browser"
panel is a sandboxed iframe with no DOM or click control
(`packages/harness/src/components/WorkspacePanels.tsx:47`). There are no automation entries in any
`package.json`.

The motivating use case is publishing a piece the agent already wrote and composed (text plus a
generated image) to a website, at a time a Routine chooses. **Publishing to a specific site is that
use case, not the feature.** The feature must let any user configure any site action from the app,
using the same profile mechanism that already exists for delivery.

Constraints that shape the decision:

- **No upstream edits.** New behaviour goes through the engine-plugin seam
  (`packages/remote/src/engine-plugins.ts`, `Hooks.tool`) or FlupCode-owned packages.
- **The tool seam is the plugin, not MCP.** Code turns already run on the legacy runtime
  (`packages/harness/src/client.ts`, `client.session.promptAsync`), which supports plugin tools and
  `ctx.ask`. MCP tools bypass the tool registry and cannot call `ctx.ask` for one call; a browser
  reached through MCP cannot be approved per action. That rules out the Playwright MCP server as the
  product path.
- **The desktop app (Electron, macOS first) is the wave-1 target.** Native OS automation is a later,
  different medium, not a variant of this one.

## Decision

### 1. A capability, not a use case: `flupcode.actions`

Add one top-level configuration key, **`flupcode.actions`**, holding profiles keyed by id. A profile
describes a web action as a declarative recipe. A publishing site, a booking site, a status page:
configuration, never repository code. Publishing is one profile; reading a value from a page is
another.

The rule, written here and in `docs/WEB-ACTIONS.md`:

> **One top-level configuration key per medium/backend; one profile per use case.**

Web actions live under `flupcode.actions` with `kind: "browser"` now; `kind: "api"` and
`kind: "mcp"` are reserved for later backends. Native OS automation is a different medium — a
different runtime, availability, schema vocabulary, permission surface and risk class — and will get
its own key, **`flupcode.os`**, sharing the same envelope and runner rather than becoming a profile
inside `actions`.

`flupcode.delivery` is untouched: it composes a piece and hands it to a person with no side effects,
which is a distinct concern. Unifying it later under a `handoff` kind is possible and out of scope.

### 2. One envelope; steps are per kind

Every profile carries the same envelope:

```
tool, description, kind, origin, credential, inputs, steps, extract, guards, sensitive,
availability, evidence
```

`kind` selects the executor. The step vocabulary is a discriminated union per `kind`: web uses
`goto`, `waitFor`, `fill`, `click`, `upload`, `submit`, `assert`, `screenshot`; a future `os` kind
uses `app`, `window`, `element`, `coords`, `keystroke`. An unsupported `kind` is refused, never
silently ignored.

### 3. Declarative recipe, deterministic execution

The recipe is the flow; the model supplies only the values (`inputs`). The runner executes steps
deterministically with a per-step timeout, bounded retries and per-step evidence (a screenshot). The
agent cannot improvise the sequence. A recurring publish is therefore reproducible and testable. A
hybrid fallback where the agent pilots clicks is explicitly out of scope.

### 4. `harness-server` owns the browser; the plugin is a thin proxy

The browser runtime — Playwright plus a persistent, isolated Chromium profile per project — lives in
`packages/harness-server`, which already owns SQLite, SSE, artifacts, the scheduler and the artifact
`raw` route, and is spawned by the desktop app
(`packages/harness-desktop/src/main/server.ts:240`). A regenerated plain-JS engine plugin (mirroring
`DELIVERY_PLUGIN` in `packages/remote/src/engine-plugins.ts`) registers the tools and is the only
component that can call `ctx.ask`. The plugin holds no browser state, no selectors and no
credentials.

### 5. Per-sensitive-action approval; credentials never cross the transcript

Two permissions: **`browser`** (navigate/read) and **`browser_sensitive`** (click/type/submit/
credential). The resource grammar is `origin` for `browser` and `origin:action` for
`browser_sensitive`. The plugin calls `ctx.ask` before every side-effecting step. The agent
references a credential **by name**; the vault resolves and injects it inside the runtime, and the
value never enters the transcript, a tool result or an artifact. Screenshots and DOM snapshots are
redacted at capture.

### 6. Scheduling is Routines, not a new mechanism

A scheduled action is a Routine (`packages/harness-server/src/scheduler.ts`) whose prompt drives the
agent and whose agent configuration carries explicit allow rules for the origins it needs. An
unattended `ask` cannot be answered, so a browser Routine without allow rules is refused at creation
with an actionable warning instead of hanging silently.

### 7. Live view is frame polling; takeover reveals the real window

The user watches through a polled `GET .../frame` PNG backed by the existing `screenshot` artifact
kind, and takes over by revealing the headed managed Chromium and pausing the agent. Wave 1 has no
binary WebSocket to the renderer and no input forwarding: the PTY WebSocket lives on the engine and
is reached through `engineSocket`, whereas `harness-server` is reached through `anonymousFetch` and
is not tunnel-capable (`packages/harness/src/transport.ts`).

### 8. Security is a precondition, not a phase

The loopback bearer token for `/harness/browser/*` and the SSRF/egress guard land in the first
runtime ticket, **before the first navigation exists**. Page content is untrusted input. A
non-`http(s)` scheme, a loopback/link-local/private address or a cloud-metadata endpoint is refused
by the runtime, not by the prompt.

## Consequences

Positive:

- Any website action is configuration authored in the app and versioned in the user's own config
  repository. No product name enters FlupCode, and `bun run repo-hygiene` keeps it that way.
- Reuses the delivery-profile pattern, `harness-server` (SQLite, SSE, artifacts, scheduler),
  the engine permission model, artifacts and Routines.
- Deterministic and testable: a local fixture site exercises the whole loop (navigate, fill, upload,
  submit, extract) without touching a third party.

Negative / accepted costs:

- A new runtime and a bundled Chromium (~150–250 MB), plus signing of nested Chromium binaries, the
  highest-uncertainty packaging item (F5-4 is already blocked).
- Third-party terms of service and anti-bot measures (CAPTCHA, 2FA) are the user's responsibility;
  some sites will break and some actions may violate a site's terms.
- Redaction cannot be complete (canvas-rendered secrets, third-party password managers). An
  unredacted capture requires explicit approval.
- The engine merges session modes after the agent floor and `evaluate` uses the last matching rule,
  so a mode can downgrade a `deny` to `ask`. The whole-engine kill switch
  (`FLUPCODE_BROWSER_DISABLED`) is the floor that cannot be downgraded; the per-agent guarantee is
  documentation, not a hard invariant.
- A deny expressed as `browser` does not hide the `browser_*` tools from the model, because the
  engine's `disabled` filter matches a rule's permission against the tool id. Deny is enforced at
  `ctx.ask`; hiding would require a future change to use ids that match the permission keys.

## Alternatives considered

| Alternative                                     | Why it is not adopted                                                                                                                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local Playwright MCP server (`@playwright/mcp`) | MCP tools bypass the tool registry and cannot call `ctx.ask`, so there is no per-action approval; also no profile isolation, redaction or artifact indexing. Kept only as an internal mapping spike. |
| The plugin owns Playwright                      | The plugin is regenerated plain JS with no third-party imports and no access to SQLite, SSE, artifacts or the scheduler; embedding browser lifecycle there is fragile against upstream sync.         |
| Agent-driven clicks, no recipe                  | Non-deterministic, hard to validate, not reproducible for a recurring publish.                                                                                                                       |
| `flupcode.os` merged into `actions` now         | OS control has a different runtime, availability, schema vocabulary and trust boundary; it gets its own key sharing the envelope.                                                                    |
| A new `harness-server` browser task kind        | Duplicates the agent runner; an agent task in a normal run already inherits sessions, approvals, artifacts and checkpoints.                                                                          |
| Electron main owns the browser                  | No HTTP surface for the agent, and it would need screen-recording entitlements and a second channel.                                                                                                 |
| A binary WebSocket for live frames              | The harness-server socket is not tunnel-capable and frames are large and one-directional; polling plus the `screenshot` artifact is smaller and respects the existing precedent.                     |

## Implementation plan

Full breakdown in `docs/tickets/WA-web-actions.md` (phases WA-0…WA-10): contract and docs; browser
runtime and boundary; recipe engine; plugin tools and approval; permissions and UI; credentials,
profiles and redaction; live view and takeover; Routines integration; configuration UI; packaging
and hardening; validation PoC. The related capability contract is `docs/WEB-ACTIONS.md`.

## Out of scope

- Native OS input control, OS screen capture, accessibility APIs (`flupcode.os`, future).
- `kind: "api"` and `kind: "mcp"` backends (reserved, not implemented).
- Cloud/hosted browser and mobile/remote control of the browser.
- Windows/Linux parity (macOS first).
- A password-manager product; the vault exists only to inject a named credential.
- Editing any upstream package.
