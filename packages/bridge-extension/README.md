# FlupCode Bridge

A Manifest V3 extension for Chrome and Edge (any Chromium browser) that lets FlupCode's agent work in
the person's own browser, inside one tab group, under FlupCode's browser policy (BU-04, audit §9.5).

- **Reach.** Only tabs in a group titled **FlupCode**: the tabs the agent opens, plus any the person
  drags into the group or hands over from the toolbar popup. Every request names a tab, and the
  extension checks the group at that moment; the harness checks it too.
- **What it forwards.** A fixed CDP subset (`CDP_METHODS` in `src/protocol.ts`): the accessibility
  tree, focusing and locating an element, mouse and keyboard input, history and navigation, layout
  metrics and screenshots. Nothing that evaluates script, reads cookies or storage, or reaches
  another target.
- **Consent stays visible.** The debugger attaches only to a tab the agent acts on, and Chrome shows
  its "started debugging this browser" bar while it does. Nothing here suppresses it. While a tab is
  attached it has an orange frame and a **Take back** button; the bar's **Cancel** and the popup's
  **Take back all tabs** take the whole browser back.
- **Egress.** While the agent controls a tab, every document it loads (redirects and frames
  included) waits for the harness's egress guard. No answer in 10 seconds is a no.
- **Transport.** One WebSocket to the loopback harness, `ws://127.0.0.1:4097/harness/bridge/socket`
  (port configurable in the popup), with a ping every 20 seconds so the service worker stays alive
  (Chrome 116+). The harness only accepts it from this extension's origin.
- **Closing the app** closes the socket, and the extension detaches the debugger from every tab.

Permissions: `debugger`, `tabs`, `tabGroups`, plus `storage` (the pairing token) and `alarms` (to
find the app again every 30 seconds after it restarts). No host permissions, no content scripts.

## Pairing

1. With FlupCode open, the extension connects and waits. The app's **Agent browser** panel shows
   "Chrome wants to connect" with a code; the extension's popup shows the same code.
2. Click **Pair** in the app. That is the only step. The extension gets a token that opens its
   socket and nothing else (the harness refuses it on every HTTP route); the harness keeps only its
   hash, in `paired-browsers.json` in FlupCode's config folder.
3. **Forget** in the same panel unpairs it. The browser then shows up again as waiting.

## Load it unpacked (development)

```sh
cd packages/bridge-extension
bun run build            # writes dist/
```

Then in Chrome or Edge: open `chrome://extensions` (`edge://extensions`), turn on **Developer mode**,
click **Load unpacked** and pick `packages/bridge-extension/dist`. The `key` in `manifest.json` pins
the extension id to `hchmfbnibhoapbmbdjpkifleoobpbkme`, the one the harness lets in
(`BRIDGE_EXTENSION_IDS` in `packages/harness-server/src/browser-bridge.ts`). Branded Chrome 137+
ignores `--load-extension`; Load unpacked still works.

Use a profile you do not mind giving the agent: the extension reaches only its FlupCode group, but
that group is in your real browser, with your sessions. The tests never touch a real profile: they
load the build into Playwright's own Chromium on a temporary profile
(`packages/harness-server/src/browser-bridge.fixture.ts`).

Tests: `bun test` here (manifest, CDP subset, build), and from `packages/harness-server`
`bun test src/browser-bridge.test.ts` and
`FLUPCODE_CONTRACT_LINE=v2 bun test src/browser-bridge.engine.test.ts` (Chromium, and the pinned
engine for the second).

## Publishing (not done yet: for the maintainer)

Nothing has been submitted to any store. When it is time:

1. **Build and zip.** `bun run build`, then zip the contents of `dist/` (the manifest at the zip's
   root). Remove the `key` field from the zipped `manifest.json`: the stores assign their own.
2. **Chrome Web Store.** Register a developer account (one-time fee) at
   https://chrome.google.com/webstore/devconsole, create an item and upload the zip. Fill in the
   listing (description, 128x128 icon is `icons/icon-128.png`, screenshots) and the privacy
   practices: the single purpose ("lets the FlupCode desktop app's agent act in a tab group of this
   browser"), a justification for each permission (`debugger`: read and act in the agent's tabs;
   `tabs` and `tabGroups`: keep the agent inside the FlupCode group; `storage`: the pairing token;
   `alarms`: reconnect to the local app), and that no data leaves the machine (the only connection
   is to `127.0.0.1`). Expect an in-depth review for `debugger`.
3. **Microsoft Edge Add-ons.** Register at https://partner.microsoft.com/dashboard/microsoftedge
   (free), create an extension and upload the same zip with the same justifications.
4. **Let the harness accept the store builds.** Each store gives the extension its own id (shown in
   the dashboard after the first upload). Add both ids to `BRIDGE_EXTENSION_IDS`, keeping the
   development id, and release the app with them. To make Load unpacked match the Chrome Web Store
   id instead, put the store's public key (Dashboard → Package → Public key) in `manifest.json`'s
   `key`.
5. **Updates** are new zips with a higher `version`: the build takes it from this package's
   `package.json`, which moves with the app's releases.
