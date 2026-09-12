import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { app } from "electron"

export const SERVER_URL = process.env.FLUPCODE_SERVER_URL ?? "http://127.0.0.1:4096"

let child: ChildProcess | undefined

export async function isServerHealthy() {
  try {
    const response = await fetch(`${SERVER_URL}/global/health`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

function opencodeDir() {
  return join(app.getAppPath(), "..", "..", "packages", "opencode")
}

export async function ensureServer() {
  if (process.env.FLUPCODE_NO_SERVER === "1") return
  if (await isServerHealthy()) return

  const directory = opencodeDir()
  if (!existsSync(join(directory, "src", "index.ts"))) return

  child = spawn(process.env.FLUPCODE_BUN ?? "bun", ["run", "./src/index.ts", "serve", "--port", "4096"], {
    cwd: directory,
    stdio: "inherit",
  })

  for (let attempt = 0; attempt < 30; attempt++) {
    if (await isServerHealthy()) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

export function stopServer() {
  child?.kill()
  child = undefined
}
