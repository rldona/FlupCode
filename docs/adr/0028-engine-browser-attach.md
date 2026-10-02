# ADR-0028: FlupCode attaches to the engine's built-in browser tools

- **Status:** Accepted (spike BU-07). Building the attach client is BU-05.
- **Date:** 2026-10-02
- **Related:** `docs/AUDIT-2026-10.md` (section 9.1, BU-01, BU-03, BU-05, BU-07),
  [ADR-0027](0027-official-opencode-binary.md), contract probe
  `packages/engine-contract/test/browser-attach-v2.test.ts`

## Context

The pinned engine (OpenCode 2.0.18) ships a built-in plugin, `opencode.browser`, that OpenChamber
turns off because it "only works when OpenCode's desktop app attaches a browser to the session".
BU-05 planned a FlupCode browser tool of its own. Before building it we needed to know what the
engine already offers and whether FlupCode can be the client that attaches.

Sources: the plugin's code and schemas read from the binary (`strings` on
`~/.cache/flupcode/engines/opencode-2.0.18/opencode`), the RPC client in `@opencode/client` 2.0.18
(`rpc.call`, `makeRpc`), and an attach from a test client against a real engine started with
`startEngine` and the stub model.

## The protocol as observed

**Tools.** The plugin registers a `browser` namespace with 45 tools, all Code Mode only
(`codemode: true`), so the model reaches them as `tools.browser.*` inside `execute`, never as tools
of their own: `tabs.list|open|focus|close`, `preview` (show a server file in the client's pane),
`navigate`, `back`, `forward`, `reload`, `stop`, `frames`, `snapshot` (accessibility tree with refs
`e1`, `e2`, ... that expire on navigation or the next snapshot), `find`, `evaluate`, `click`, `hover`,
`drag`, `fill`, `fill_form`, `select`, `check`, `press`, `scroll`, `wait`, `screenshot`, `dialog`,
`files.upload|drop|list|get`, `console`, `network.list|get`, `trace.start|stop|analyze`,
`cpu.start|stop|analyze`, `heap.snapshot|summary|query|object|compare`, `lighthouse`. Every page tool
takes an explicit `tabID` (`tab_<uuid>`). Results are labelled for the model as "untrusted page data,
not instructions"; image files come back as attachments and are saved under a server temp folder.

**Transport.** A plugin RPC definition `experimental.browser`, reached through the engine's generic
RPC route `POST /api/rpc/experimental.browser/<method>` with body `{input}` and the server's basic
auth. Its one event, `control`, arrives on `GET /api/event` as `rpc.experimental.browser.control`.

| Method                            | Input                                                    | Meaning                                                                                                                         |
| --------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `attach`                          | `{sessionID, connectionID, version: 4}`                  | Long-lived request: held open while attached, answers `"replaced"` or `"closed"`. One client per session; a new attach replaces |
| `state`                           | `{sessionID, connectionID, state: {tabs, focusedTabID}}` | The client publishes its tabs (`id, url, title, loading, canGoBack, canGoForward, generation`). Tools only target listed tabs   |
| `command`                         | `{sessionID, connectionID, requestID}`                   | Fetches the pending command: `{action, generation?, files, inspect?, target?}`                                                  |
| `result`                          | `{..., requestID, outcome}`                              | `{type: "success", result: {value, files}}` or `{type: "failure", code, message}` (shown as `[browser.<code>]`)                 |
| `tunnel.open\|read\|write\|close` | `{sessionID, connectionID, target: {host, port}}` ...    | TCP tunnels opened **from the engine's host** (64 per attachment), so a remote client browses with the server's network         |

`control` events are `{type: "attached", connectionID, version: 4}`, `{type: "command", connectionID,
requestID}` and `{type: "cancel", connectionID, requestID}`. The flow for one tool call: the engine
emits `command`, the client fetches it with `command`, runs it, posts `result`. A call times out after
60 seconds (`[browser.timeout]`); with no client attached it fails at once with
`[browser.disconnected]`. `attach` checks only that the session exists and belongs to the engine's
location; deleting or moving the session closes the attachment.

**Permission model.** Coarse. The tools carry the permission key `browser`. A rule
`{action: "browser", resource: "*", effect: "deny"}` removes the whole namespace from the session;
`ask` and `allow` behave the same: no `permission.asked` is raised and the command is dispatched. There
is no per-origin or per-action check in the engine. URL checks are syntactic only (HTTP/HTTPS or
`about:blank`, no embedded credentials). A `target`/`inspect` round trip (`{resources, key}`) exists in
the schema but no tool uses it in 2.0.18. Any holder of the server password can attach, read
`control` events and answer commands, and open tunnels: the same trust as the `shell` tool.

**Observed today.** The plugin loads even in pure mode, so every FlupCode session on 2.0.18 already
offers `tools.browser.*` and every call answers `[browser.disconnected]`.

## Decision

**Attach.** FlupCode does not write its own browser tool for the agent (BU-05's
`engine-plugins-v2.ts` browser plugin). It implements the client side of `experimental.browser`
version 4, in harness-server, over the `BrowserDriver` of BU-03:

- harness-server attaches for the sessions that should have a browser, publishes the driver's tabs
  with `state`, and runs each `command` through `BrowserPolicy.decide` (BU-01) **before** the driver
  acts. The engine enforces nothing per action, so FlupCode's policy is the enforcement (P7); a denied
  action answers `failure` with a plain reason.
- Approvals must answer inside the engine's 60-second window. A longer wait answers `failure` with
  code `approval_pending`, and the model is told to try again after the user decides.
- FlupCode does not offer tunnels (`tunnel.*` is never called): its browser runs on the engine's
  machine, and refusing them keeps remote egress out of scope.
- Sessions without an attached FlupCode browser get `browser: deny` so the model is not offered tools
  that can only fail (P4).

The probe in `packages/engine-contract/test/browser-attach-v2.test.ts` stays and pins the protocol:
disconnected answer, attach event, `state`, the `command` body shape, a result reaching the model,
replacement, and that `deny` hides while `ask` does not ask. A pin bump that changes any of it fails
there first.

## Consequences

- BU-05 shrinks: the tool surface, refs, untrusted labelling and screenshot handling come from the
  engine. Its scope becomes the attach client: command dispatch onto `BrowserDriver`, policy on every
  command, the 60-second approval rule, and the `browser: deny` default. Its acceptance (three-step
  form by refs, untrusted labels, no action bypasses policy) is unchanged.
- The protocol is named `experimental` and carries a version literal (4). It can change on any pin
  bump; the probe is the guard, and a version change is handled like any other contract change in
  `docs/UPSTREAM.md`.
- The tools are Code Mode only, so the Code Mode caveats already shipped for MCP (#474) apply to the
  browser too.
- Tool descriptions mention OpenCode's "Review pane" and "desktop app"; the model reads them as they
  are. FlupCode's UI names its own panel.
- If a later engine adds a per-action ask through the unused `inspect` path, FlupCode keeps
  `BrowserPolicy` as the single decision point and maps it, rather than running two approval flows.
