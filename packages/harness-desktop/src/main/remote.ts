import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { BrowserWindow, app, ipcMain, safeStorage } from "electron"
import { createRemoteHost, type RemoteHostStore } from "@flupcode/remote"
import { HARNESS_SERVER_URL, SERVER_URL, engineCredentials } from "./server"

/**
 * Remote control host (ADR-0010): file-backed storage and the IPC bridge for the renderer.
 *
 * Windows and Linux keep the secrets encrypted with the OS keychain (`safeStorage`). macOS does
 * not: an ad-hoc signed build (F5-4) gets a new code signature on every release, so the keychain
 * treats the updated app as a different one and asks for the login password on each update. There
 * `remote.json` is protected by file permissions only.
 */

type Envelope = { v: 1; encrypted: boolean; data: string }

const usesKeychain = () => process.platform !== "darwin" && safeStorage.isEncryptionAvailable()

function storeFile() {
  return join(app.getPath("userData"), "remote.json")
}

function parse(json: string): RemoteHostStore {
  const stored = JSON.parse(json) as Partial<RemoteHostStore>
  return {
    enabled: stored.enabled === true,
    relay: stored.relay,
    identity: stored.identity,
    devices: stored.devices ?? [],
  }
}

/**
 * Reads the store, migrating a keychain-encrypted macOS file to plaintext once so later launches
 * never touch the keychain. A failed (or denied) migration resets the store rather than prompting
 * again.
 */
function readStore(): RemoteHostStore {
  try {
    if (!existsSync(storeFile())) return { enabled: false, devices: [] }
    const envelope = JSON.parse(readFileSync(storeFile(), "utf8")) as Envelope
    if (!envelope.encrypted) return parse(Buffer.from(envelope.data, "base64").toString("utf8"))
    try {
      const stored = parse(safeStorage.decryptString(Buffer.from(envelope.data, "base64")))
      if (!usesKeychain()) writeStore(stored)
      return stored
    } catch {
      const empty: RemoteHostStore = { enabled: false, devices: [] }
      writeStore(empty)
      return empty
    }
  } catch {
    return { enabled: false, devices: [] }
  }
}

function writeStore(stored: RemoteHostStore) {
  const encrypted = usesKeychain()
  const json = JSON.stringify(stored)
  const envelope: Envelope = {
    v: 1,
    encrypted,
    data: encrypted ? safeStorage.encryptString(json).toString("base64") : Buffer.from(json).toString("base64"),
  }
  writeFileSync(storeFile(), JSON.stringify(envelope), { mode: 0o600 })
}

export function initRemoteHost() {
  const host = createRemoteHost({
    load: readStore,
    save: writeStore,
    engine: SERVER_URL,
    engineCredentials: engineCredentials(),
    harness: HARNESS_SERVER_URL,
    defaultRelay: process.env.FLUPCODE_RELAY_URL ?? "wss://relay.flupcode.com",
    appUrl: process.env.FLUPCODE_APP_URL ?? "https://app.flupcode.com/",
    hostName: hostname(),
    secureStorage: usesKeychain(),
    onChange: (state) =>
      BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("flupcode:remote-changed", state)),
  })

  ipcMain.handle("flupcode:remote-state", async () => {
    await host.ready
    return host.state()
  })
  ipcMain.handle("flupcode:remote-enable", (_event, enabled: boolean) => host.setEnabled(enabled === true))
  ipcMain.handle("flupcode:remote-relay", (_event, relay: string) => host.setRelay(String(relay)))
  ipcMain.handle("flupcode:remote-pair", () => host.createPairing())
  ipcMain.handle("flupcode:remote-cancel-pair", () => host.cancelPairing())
  ipcMain.handle("flupcode:remote-revoke", (_event, id: string) => host.revokeDevice(String(id)))

  return { stop: host.stop }
}
