import { expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildExtension } from "../script/build"
import { CDP_METHODS } from "../src/protocol"

/** What FlupCode Bridge asks of the browser, and what it forwards (BU-04). */

test("the manifest asks for the debugger, tabs and tab groups, and no host access", async () => {
  const manifest = await Bun.file(join(import.meta.dir, "..", "manifest.json")).json()
  expect(manifest.manifest_version).toBe(3)
  // `storage` keeps the pairing token; `alarms` finds the app again after it restarts.
  expect([...manifest.permissions].sort()).toEqual(["alarms", "debugger", "storage", "tabGroups", "tabs"])
  expect(manifest.host_permissions).toBeUndefined()
  expect(manifest.content_scripts).toBeUndefined()
  expect(manifest.externally_connectable).toBeUndefined()
})

test("the CDP subset reads, types, clicks and navigates, and nothing that runs script or reads storage", () => {
  const domains = new Set([...CDP_METHODS].map((method) => method.split(".")[0]))
  expect([...domains].sort()).toEqual(["Accessibility", "DOM", "Input", "Page"])
  for (const method of ["Runtime.evaluate", "Network.getCookies", "Storage.getCookies", "Target.attachToTarget", "Page.addScriptToEvaluateOnNewDocument"])
    expect(CDP_METHODS.has(method)).toBe(false)
})

test("the build is a folder Chrome loads unpacked, at the package's version", async () => {
  const outdir = mkdtempSync(join(tmpdir(), "flupcode-bridge-build-"))
  try {
    await buildExtension(outdir)
    expect(readdirSync(outdir).sort()).toEqual(["_locales", "background.js", "icons", "manifest.json", "popup.html", "popup.js"])
    const manifest = await Bun.file(join(outdir, "manifest.json")).json()
    expect(manifest.version).toBe((await Bun.file(join(import.meta.dir, "..", "package.json")).json()).version)
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
})
