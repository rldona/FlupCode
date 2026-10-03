/// <reference path="../../bridge-extension/src/chrome.d.ts" />
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildExtension } from "@flupcode/bridge-extension/build"
import { SOCKET_PATH } from "@flupcode/bridge-extension/protocol"
import type { BrowserContext, Worker } from "playwright-core"
import { createHarnessHandler, type HarnessHandlerOptions } from "./api"
import { createBrowserBridge } from "./browser-bridge"
import type { EgressGuard } from "./browser-egress"
import type { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"

/**
 * FlupCode Bridge for real, for tests (BU-04): the extension built from `packages/bridge-extension`
 * and loaded unpacked into Playwright's own Chromium, on a throwaway profile (`--load-extension`;
 * never a person's browser), and a harness serving the bridge's socket and routes on a free port.
 */

export const BRIDGE_UI_TOKEN = "bridge-ui-token"

/** A harness with the bridge's socket and `/harness/bridge/*`, as `createHarnessServer` serves them. */
export function startBridgeHarness(input: {
  repository: SqliteRoutineRepository
  egress: EgressGuard
  dataDir: string
  options?: Omit<HarnessHandlerOptions, "bridge">
}) {
  const bridge = createBrowserBridge({
    repository: input.repository,
    egress: input.egress,
    hostname: "127.0.0.1",
    dataDir: input.dataDir,
    file: join(input.dataDir, "paired-browsers.json"),
  })
  const handler = createHarnessHandler(
    input.repository,
    new RoutineScheduler({ repository: input.repository, engineURL: "http://127.0.0.1:1" }),
    {
      token: BRIDGE_UI_TOKEN,
      ...input.options,
      bridge,
    },
  )
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, bunServer) =>
      new URL(request.url).pathname === SOCKET_PATH ? bridge.socket(request, bunServer) : handler(request),
    websocket: bridge.websocket,
  })
  const url = `http://127.0.0.1:${server.port}`
  return {
    bridge,
    url,
    port: server.port ?? 0,
    /** A call to the harness with the app's token, or with `token` when given. */
    request: async (method: string, path: string, body?: unknown, token = BRIDGE_UI_TOKEN) => {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: response.status, body: (await response.json().catch(() => undefined)) as { data?: unknown } }
    },
    /** Closing the app: the socket goes with the server. */
    stop: () => {
      bridge.stop()
      server.stop(true)
    },
  }
}

/** Playwright's Chromium with FlupCode Bridge loaded unpacked, on a profile that is thrown away after. */
export async function launchBridgeBrowser() {
  const { chromium } = await import("playwright")
  const root = mkdtempSync(join(tmpdir(), "flupcode-bridge-"))
  const extension = await buildExtension(join(root, "extension"))
  const context: BrowserContext = await chromium.launchPersistentContext(join(root, "profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  })
  const worker: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
  const extensionId = new URL(worker.url()).host
  return {
    context,
    worker,
    extensionId,
    /** Points the extension at a harness, as its popup's port field does. */
    connectTo: (port: number) => worker.evaluate((value) => chrome.storage.local.set({ port: value }), port),
    /**
     * The tabs this extension's debugger holds now, by Chrome's tab id. `getTargets` cannot tell:
     * Playwright itself is attached to every page. A command only goes through on a tab the
     * extension is attached to.
     */
    attachedTabs: () =>
      worker.evaluate(async () => {
        const tabs = (await chrome.tabs.query({})).flatMap((tab) => (tab.id === undefined ? [] : [tab.id]))
        const held = await Promise.all(
          tabs.map((tabId) =>
            chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "1" }).then(
              () => tabId,
              () => undefined,
            ),
          ),
        )
        return held.filter((tabId) => tabId !== undefined)
      }),
    /** Chrome's tabs as the extension sees them: id, address and group title. */
    chromeTabs: () =>
      worker.evaluate(async () =>
        Promise.all(
          (await chrome.tabs.query({})).map(async (tab) => ({
            tabId: tab.id!,
            url: tab.url ?? "",
            group: tab.groupId === -1 ? undefined : (await chrome.tabGroups.get(tab.groupId)).title,
          })),
        ),
      ),
    stop: async () => {
      await context.close().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/**
 * Waits for `check` to hold, polling; fails with what it waited for and what it last saw. `what`
 * names the wait, so a timeout in CI says which one it was: the stack only reaches this function.
 */
export async function until<T>(
  read: () => Promise<T> | T,
  check: (value: T) => boolean,
  timeoutMs = 15_000,
  what = "a condition",
) {
  const deadline = Date.now() + timeoutMs
  const poll = async (): Promise<T> => {
    const value = await read()
    if (check(value)) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}; last saw ${JSON.stringify(value)}`)
    await Bun.sleep(100)
    return poll()
  }
  return poll()
}
