# Your browser through an MCP preset (BU-02)

FlupCode can let the agent act in **your own browser**, signed in as you, through one of two
third-party MCP servers. It adds no binaries of its own: the presets in **Settings → MCP servers** write an
ordinary MCP server into the engine config, and FlupCode's engine plugin puts its browser approvals
(BU-01, see [WEB-ACTIONS.md](WEB-ACTIONS.md#approval)) in front of every call.

| Preset | Command | What the agent reaches |
| --- | --- | --- |
| Your browser, through the Playwright extension (default) | `npx -y @playwright/mcp@0.0.83 --extension` | Only the tabs you hand over from the Playwright Extension |
| Your Chrome, through Chrome DevTools MCP | `npx -y chrome-devtools-mcp@1.10.1 --autoConnect` | Your whole Chrome profile: every open tab and every site you are signed in to |

The versions are pinned. Moving to a newer one means checking its tool names against the tables
in `packages/harness-server/src/browser-mcp.ts` first.

## How a call is approved

Neither server asks before it acts, and the engine's own permission rules only see a tool's name.
So the `flupcode-browser-mcp.js` plugin (OpenCode 2 only) does this for each call:

1. **Recognise the server by its tools**, not by the name it was given: `browser_navigate` and
   `browser_snapshot` mean Playwright MCP; `navigate_page` and `list_pages` mean Chrome DevTools MCP.
   A server added by hand under another name is governed the same way.
2. **Keep the arguments** from the engine's `execute.before` hook. The permission hook does not
   receive them.
3. **Ask harness-server** from the engine's permission hook (`POST /harness/browser-mcp/decide`,
   plugin bearer only). The server maps the tool to a tier, works out the page it acts on, and asks
   the browser policy. When nothing decides it yet, it asks you in the session, as for a web
   action. The approval is labelled **Your browser**, not **Agent browser**.
4. **Report what came back** (`POST /harness/browser-mcp/observe`). That answer is where the
   current page's address comes from, and the call goes into the browser audit.

Tiers, by tool (the full tables are in `browser-mcp.ts`):

- **Tabs, no approval**: listing or picking tabs (`browser_tabs` list/select, `list_pages`,
  `select_page`). These read no page, only addresses and titles, and they are how FlupCode learns
  which page later calls act on.
- **read**: snapshots, screenshots, console and network reads, waiting for text.
- **navigate**: opening an address (`browser_navigate`, `navigate_page` with a URL, `new_page`).
- **interact**: clicking, typing, hovering, dragging, pressing keys, dialogs, closing a tab.
- **sensitive** (asks every time; no grant covers it): running script in the page, uploading
  files, cookies and storage, network routing, typing with submit, installing extensions. Any
  tool the tables do not know is also sensitive.

A call on "the current page" before any page is known is refused. The reason says to list the
tabs first. If you navigate the tab by hand between two calls, FlupCode cannot see it. The next
answer from the server corrects the page.

The permission hook never calls into the engine: no tool calls and no tool listing. A tool called
from there would be evaluated again and run the hook again, without end. The plugin learns the
tool catalog in the before-hook, and refuses at once any evaluation of a call it is still
deciding. `packages/remote/src/engine-plugins-v2.test.ts` ("OpenCode 2 browser-mcp") covers both
cases.

## Manual test

This test needs a real browser, so it is not in CI.
`packages/harness-server/src/browser-mcp.engine.test.ts` proves the same flow against the pinned
engine, with a stand-in for Playwright MCP.

### Setup

1. Start FlupCode on an OpenCode 2 engine (desktop app, or `bun run dev` in
   `packages/harness-desktop`).
2. Open **Settings → MCP servers**. Under **Your browser** there are two presets. Each one states what the
   agent can reach, followed by a numbered checklist.

### M1. Playwright extension (the default)

1. Install the Playwright Extension in Chrome or Edge:
   <https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm>.
2. Click **Add preset** on "Your browser, through the Playwright extension". The row turns into
   **Added**, and the server `playwright` appears in the list. Wait until it shows `connected`
   (the first `npx` download can take a minute).
3. Open `https://example.com` in a tab.
4. In a new session, ask: "List the tabs in my browser, then read the page I handed you and click
   the 'More information' link."
5. The extension asks which tab to hand over. Pick the `example.com` tab.
   - Expected: the tab list runs with no approval.
6. Expected: an approval dock shows the **Your browser** chip and asks "Let the agent read pages
   on example.com?". The browser has not been read yet. Answer **Allow for this session**.
7. Expected: a second dock asks to "click and type" on `example.com`. Answer **Allow once**. The
   click happens in your tab, which lands on `iana.org`.
8. Ask the agent to read the page again.
   - Expected: a new dock for `www.iana.org` (a new site asks again).
   - Answer **Deny**. Expected: the agent says the call failed, and nothing happens in the tab.
9. Ask the agent to open `https://accounts.google.com/`.
   - Expected: no dock appears, the call is refused, and the tab does not move (blocked site).
10. **Settings → Permissions → Browser access** lists the session grant for `example.com`, and
    you can revoke it there. The audit (`GET /harness/browser-policy/audit`, UI token) lists each
    decision, answer and action with the session.

### M2. Chrome DevTools MCP (`--autoConnect`)

1. Use Chrome 144 or later, already open, and sign in to any site.
2. Open `chrome://inspect/#remote-debugging` and turn on remote debugging.
3. Click **Add preset** on "Your Chrome, through Chrome DevTools MCP". Wait for `connected`.
4. In a new session, ask: "List my Chrome pages, then take a snapshot of the selected one."
5. Chrome asks to allow the incoming debugging connection. Allow it. Chrome then shows a banner
   saying it is being controlled.
   - Expected: `list_pages` runs with no approval.
   - Expected: `take_snapshot` asks to "read pages" on the selected page's site, with the
     **Your browser** chip.
6. Ask it to run `document.title` in the page.
   - Expected: `evaluate_script` asks as **Sensitive**, and asks again on the next call even after
     **Allow once**.

### What to look for

- Every first action on a new site asks before anything happens in the browser.
- A **session** answer covers that tier and the ones below it on that site for this session only.
- No dock ever appears for a blocked site.
- With the harness stopped, every browser call is refused ("FlupCode cannot ask for approval…").
- In a Code Mode script, a refused call shows up as `Unable to execute <server>_<tool>`. The
  refusal reason does not reach the script (see the findings in `AUDIT-2026-10.md`).
