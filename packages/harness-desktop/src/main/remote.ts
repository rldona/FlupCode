import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { BrowserWindow, app, ipcMain, safeStorage } from "electron"
import { createRemoteHost, type RemoteHostStore } from "@flupcode/remote"
import { SERVER_URL } from "./server"

/** Remote control host (ADR-0010): keychain-backed storage and the IPC bridge for the renderer. */

type Envelope = { v: 1; encrypted: boolean; data: string }

function storeFile() {
  return join(app.getPath("userData"), "remote.json")
}

function readStore(): RemoteHostStore {
  try {
    if (!existsSync(storeFile())) return { enabled: false, devices: [] }
    const envelope = JSON.parse(readFileSync(storeFile(), "utf8")) as Envelope
    const json = envelope.encrypted
      ? safeStorage.decryptString(Buffer.from(envelope.data, "base64"))
      : Buffer.from(envelope.data, "base64").toString("utf8")
    const stored = JSON.parse(json) as Partial<RemoteHostStore>
    return {
      enabled: stored.enabled === true,
      relay: stored.relay,
      identity: stored.identity,
      devices: stored.devices ?? [],
    }
  } catch {
    return { enabled: false, devices: [] }
  }
}

function writeStore(stored: RemoteHostStore) {
  const encrypted = safeStorage.isEncryptionAvailable()
  const json = JSON.stringify(stored)
  const envelope: Envelope = {
    v: 1,
    encrypted,
    data: encrypted ? safeStorage.encryptString(json).toString("base64") : Buffer.from(json).toString("base64"),
  }
  writeFileSync(storeFile(), JSON.stringify(envelope), { mode: 0o600 })
}

function engineCredentials() {
  const password = process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined
  return Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${password}`).toString("base64")
}

export function initRemoteHost() {
  const host = createRemoteHost({
    load: readStore,
    save: writeStore,
    engine: SERVER_URL,
    engineCredentials: engineCredentials(),
    defaultRelay: process.env.FLUPCODE_RELAY_URL ?? "wss://relay.flupcode.com",
    appUrl: process.env.FLUPCODE_APP_URL ?? "https://app.flupcode.com/",
    hostName: hostname(),
    secureStorage: safeStorage.isEncryptionAvailable(),
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
