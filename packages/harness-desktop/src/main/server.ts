import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { app, dialog, shell } from "electron"

export const SERVER_URL = process.env.FLUPCODE_SERVER_URL ?? "http://127.0.0.1:4096"
export const OPENCODE_DOCS = "https://opencode.ai/docs/"

let child: ChildProcess | undefined
let prompted = false

export async function isServerHealthy() {
  try {
    const response = await fetch(`${SERVER_URL}/global/health`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

function commandExists(command: string) {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore", shell: process.platform === "win32" })
  return !probe.error
}

function repoEngineDir() {
  return join(app.getAppPath(), "..", "..", "packages", "opencode")
}

function resolveEngine(): { command: string; args: string[]; cwd?: string } | undefined {
  if (process.env.FLUPCODE_OPENCODE) {
    return { command: process.env.FLUPCODE_OPENCODE, args: ["serve", "--port", "4096"] }
  }

  const directory = repoEngineDir()
  if (existsSync(join(directory, "src", "index.ts"))) {
    return {
      command: process.env.FLUPCODE_BUN ?? "bun",
      args: ["run", "./src/index.ts", "serve", "--port", "4096"],
      cwd: directory,
    }
  }

  if (commandExists("opencode")) {
    return { command: "opencode", args: ["serve", "--port", "4096"] }
  }

  return undefined
}

function promptInstall() {
  if (prompted) return
  prompted = true
  void dialog
    .showMessageBox({
      type: "info",
      title: "OpenCode engine not found",
      message: "FlupCode needs the OpenCode engine",
      detail:
        "FlupCode connects to a local OpenCode server, but no engine was found.\n\n" +
        "Install the OpenCode CLI and FlupCode will start it automatically, or start it yourself with:\n\n" +
        "    opencode serve --port 4096\n\n" +
        "Then reopen FlupCode.",
      buttons: ["Open install docs", "Continue offline"],
      defaultId: 0,
      cancelId: 1,
    })
    .then((result) => {
      if (result.response === 0) void shell.openExternal(OPENCODE_DOCS)
    })
}

export async function ensureServer() {
  if (process.env.FLUPCODE_NO_SERVER === "1") return
  if (await isServerHealthy()) return

  const engine = resolveEngine()
  if (!engine) {
    promptInstall()
    return
  }

  child = spawn(engine.command, engine.args, {
    cwd: engine.cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  })
  child.on("error", () => {
    child = undefined
  })

  for (let attempt = 0; attempt < 40; attempt++) {
    if (await isServerHealthy()) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  promptInstall()
}

export function stopServer() {
  child?.kill()
  child = undefined
}
