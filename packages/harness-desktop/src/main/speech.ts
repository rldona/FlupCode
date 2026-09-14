import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { app, ipcMain, webContents } from "electron"
import type { SpeechEvent } from "@flupcode/remote"

/**
 * Native dictation for macOS. Electron cannot use the Web Speech API (Chromium's cloud service is
 * Chrome-only and the on-device binder is missing), so we spawn a small Swift helper that wraps
 * `SFSpeechRecognizer` and stream its JSON events to the renderer.
 */

function helperPath() {
  if (process.platform !== "darwin") return
  const path = app.isPackaged
    ? join(process.resourcesPath, "speech", "speech-helper")
    : join(app.getAppPath(), "out", "speech", "speech-helper")
  return existsSync(path) ? path : undefined
}

export function speechAvailable() {
  return helperPath() !== undefined
}

let helper: ChildProcessWithoutNullStreams | undefined
let owner: number | undefined

function send(event: SpeechEvent) {
  if (owner === undefined) return
  const contents = webContents.fromId(owner)
  if (contents && !contents.isDestroyed()) contents.send("flupcode:speech-event", event)
}

function cancel() {
  helper?.kill()
  helper = undefined
  owner = undefined
}

function start(sender: Electron.WebContents, lang: string) {
  cancel()
  const path = helperPath()
  if (!path) {
    sender.send("flupcode:speech-event", {
      type: "error",
      code: "unavailable",
      message: "Native speech recognition is not available",
    })
    return
  }

  owner = sender.id
  const child = spawn(path, [lang])
  helper = child
  sender.once("destroyed", () => {
    if (owner === sender.id) cancel()
  })

  let buffered = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk
    const lines = buffered.split("\n")
    buffered = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        send(JSON.parse(line) as SpeechEvent)
      } catch {
        // A malformed line is the helper's problem; keep the rest of the stream usable.
      }
    }
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => console.error("[speech]", chunk.trim()))
  child.on("error", (error) => send({ type: "error", code: "spawn", message: error.message }))
  child.on("exit", () => {
    if (helper === child) {
      send({ type: "end" })
      helper = undefined
      owner = undefined
    }
  })
}

export function initSpeech() {
  if (!speechAvailable()) return

  ipcMain.handle("flupcode:speech-start", (event, lang?: string) => {
    start(event.sender, lang || app.getLocale() || "en-US")
  })
  ipcMain.handle("flupcode:speech-stop", () => {
    helper?.stdin.write("stop\n")
  })
  ipcMain.handle("flupcode:speech-cancel", () => {
    cancel()
  })
}

export function stopSpeech() {
  cancel()
}
