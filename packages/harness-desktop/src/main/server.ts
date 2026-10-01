import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { app, dialog, shell } from "electron"
import { detectEngine, openCodeV2Locked } from "@flupcode/remote/engine-kind"
import { installEnginePlugins } from "@flupcode/remote/engine-plugins"
import { startEngineProxy } from "@flupcode/remote/engine-proxy"
import { openCodeV2Env, OPENCODE_V2_VERSION, resolveOpenCodeV2 } from "@flupcode/remote/opencode-v2"
import { readOrCreateFileToken } from "./browser-token-file"
import { vaultKeyForHarness } from "./vault"

export const SERVER_URL = process.env.FLUPCODE_SERVER_URL ?? "http://127.0.0.1:4096"
export const HARNESS_SERVER_URL = process.env.FLUPCODE_HARNESS_SERVER_URL ?? "http://127.0.0.1:4097"
export const OPENCODE_DOCS = "https://opencode.ai/docs/"
/**
 * Where an OpenCode 2 engine this app starts listens (2.1). `SERVER_URL` is the engine proxy in front
 * of it, which signs in for the window, the harness and FlupCode's web app alike: 2.x always asks for a
 * password, and a web page has no way to send one.
 */
const ENGINE_PORT = Number(process.env.FLUPCODE_ENGINE_PORT ?? 4098)
const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`

let child: ChildProcess | undefined
let proxy: Awaited<ReturnType<typeof startEngineProxy>> | undefined
let harnessChild: ChildProcess | undefined
let prompted = false
let promptedRestart = false
let promptedLocked = false

/**
 * The engine answers any request from any `http://localhost:*` origin, so an unsecured one lets
 * every page the machine serves drive the agent. The engine FlupCode starts gets a password for the
 * life of the app; one the user started keeps whatever they configured through the environment.
 */
// 2.x has no user name setting: it always signs in as "opencode".
let password = process.env.OPENCODE_SERVER_PASSWORD

/** `base64(user:pass)` for the engine, or nothing when it needs no credentials. */
export function engineCredentials() {
  return password ? Buffer.from(`opencode:${password}`).toString("base64") : undefined
}

/**
 * Decide the password the engine will be started under, before either child is spawned.
 *
 * The harness starts first — its actions plugin has to exist when the engine loads — yet it is the
 * process that talks to the engine on the scheduler's behalf, so it needs the same credential. It
 * cannot be generated lazily when the engine starts any more; an engine the user started keeps
 * whatever they configured through the environment, which `password` already holds.
 */
export function ensureEngineCredentials() {
  password = password || randomBytes(24).toString("hex")
  return password
}

let browserToken = process.env.FLUPCODE_BROWSER_TOKEN?.trim() || undefined

/**
 * The loopback token the harness and the engine share so the live view can drive the browser
 * (WA-6). `FLUPCODE_BROWSER_TOKEN` still wins when set; otherwise the first launch persists a
 * token beside the harness's own files (`0600`) and later launches reuse it — as does an engine
 * the user started by hand, which reads the same file. A desktop restart must not silently
 * disable every web-action by rotating a token nobody else was told about.
 */
export function harnessBrowserToken() {
  browserToken = browserToken || readOrCreateFileToken() || randomBytes(32).toString("hex")
  return browserToken
}

function authHeaders() {
  const credentials = engineCredentials()
  return credentials ? { authorization: `Basic ${credentials}` } : undefined
}

function runningEngine() {
  return detectEngine(SERVER_URL, fetch, { headers: authHeaders() })
}

export async function isHarnessServerHealthy() {
  try {
    const response = await fetch(`${HARNESS_SERVER_URL}/harness/health`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

function commandExists(command: string) {
  const probe = spawnSync(command, ["--version"], {
    stdio: "ignore",
    env: { ...process.env, PATH: searchPath() },
    shell: process.platform === "win32",
  })
  return !probe.error
}

/**
 * The PATH the engine is looked up in, and the one the processes we start run with.
 *
 * An app opened from the Finder or the Dock inherits launchd's PATH — `/usr/bin:/bin:/usr/sbin:/sbin`
 * on macOS — not the one the user's shell builds. An engine installed by Homebrew, bun or the
 * OpenCode installer is invisible to it, so FlupCode would say it is offline on a machine where
 * `opencode serve` runs fine in a terminal. The login shell's PATH is asked for once and merged in,
 * together with the usual install folders in case the shell cannot be read. The children get the
 * same value: the agent's own tools (git, node, a formatter) have to be found too.
 */
let mergedPath: string | undefined
function searchPath() {
  if (mergedPath) return mergedPath
  const home = homedir()
  const known =
    process.platform === "win32"
      ? []
      : [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          join(home, ".opencode", "bin"),
          join(home, ".local", "bin"),
          join(home, ".bun", "bin"),
        ]
  const entries = [...(process.env.PATH ?? "").split(delimiter), ...loginShellPath(), ...known]
  mergedPath = Array.from(new Set(entries.filter((entry) => entry))).join(delimiter)
  return mergedPath
}

function loginShellPath() {
  // Only for a packaged app: in development the terminal's PATH is already the user's, and starting
  // a login shell there would only cost time.
  if (!app.isPackaged || process.platform === "win32" || !process.env.SHELL) return []
  const probe = spawnSync(process.env.SHELL, ["-ilc", "printf %s \"$PATH\""], {
    encoding: "utf8",
    timeout: 5000,
    // A shell that asks something on startup must not hold the app up: it gets no input at all.
    stdio: ["ignore", "pipe", "ignore"],
  })
  return (probe.stdout ?? "").trim().split(delimiter)
}

function repoHarnessDir() {
  return join(app.getAppPath(), "..", "..", "packages", "harness-server")
}

/**
 * The proxy at `SERVER_URL` in front of the engine, started once: across an engine restart (the
 * 1.x import) it keeps listening and answers 502 until the engine is back. Besides FlupCode's web app
 * it serves this app's own window, whose origin is `oc://renderer` (or the dev server's).
 */
async function serveEngine() {
  const credentials = engineCredentials()
  if (proxy || !credentials) return
  const renderer = process.env.ELECTRON_RENDERER_URL ? new URL(process.env.ELECTRON_RENDERER_URL).origin : undefined
  proxy = await startEngineProxy({
    port: Number(new URL(SERVER_URL).port || 4096),
    engine: ENGINE_URL,
    authorization: `Basic ${credentials}`,
    origins: ["oc://renderer", ...(renderer ? [renderer] : [])],
  }).catch((cause: unknown) => {
    console.error(
      `[flupcode] could not serve the engine at ${SERVER_URL}: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    return undefined
  })
}

function resolveHarnessServer(): { command: string; args: string[]; cwd?: string } | undefined {
  if (process.env.FLUPCODE_HARNESS_SERVER) {
    return { command: process.env.FLUPCODE_HARNESS_SERVER, args: [] }
  }

  // `bun build --compile` writes `flupcode-harness.exe` on Windows whatever the outfile says, so the
  // packaged binary is looked for under the name it actually has. Asking for the wrong one is how
  // 1.8.0 shipped a Windows app with no server at all, silently: electron-builder skipped a resource
  // that did not exist and the build stayed green.
  const packagedName = process.platform === "win32" ? "flupcode-harness.exe" : "flupcode-harness"
  const packaged = join(process.resourcesPath, "harness-server", packagedName)
  if (existsSync(packaged)) return { command: packaged, args: [] }

  const directory = repoHarnessDir()
  if (existsSync(join(directory, "src", "index.ts"))) {
    return {
      command: process.env.FLUPCODE_BUN ?? "bun",
      args: ["run", "./src/index.ts"],
      cwd: directory,
    }
  }

  if (commandExists("flupcode-harness")) return { command: "flupcode-harness", args: [] }
  return undefined
}

function promptNoEngine() {
  if (prompted) return
  prompted = true
  void dialog
    .showMessageBox({
      type: "warning",
      title: "OpenCode 2 is not available",
      message: `FlupCode could not start OpenCode ${OPENCODE_V2_VERSION}`,
      detail:
        "FlupCode downloads its OpenCode 2 engine once and keeps it in its cache. The download or the start " +
        "failed, so FlupCode is offline for now.\n\n" +
        "Check the connection and reopen FlupCode, or name an OpenCode 2 binary with FLUPCODE_OPENCODE.",
      buttons: ["Open OpenCode docs", "Continue offline"],
      defaultId: 1,
      cancelId: 1,
    })
    .then((result) => {
      if (result.response === 0) void shell.openExternal(OPENCODE_DOCS)
    })
}

/** An OpenCode 1.x engine on FlupCode's port: it would take the address the 2.x engine needs. */
function promptLegacyEngine(version: string | undefined) {
  if (prompted) return
  prompted = true
  void dialog.showMessageBox({
    type: "warning",
    title: "OpenCode 1.x is no longer supported",
    message: `An OpenCode ${version ?? "1.x"} engine is running at ${SERVER_URL}`,
    detail:
      "FlupCode runs on OpenCode 2 now. Stop that engine and reopen FlupCode, which starts its own.\n\n" +
      "Your 1.x history stays where it is: File → Import OpenCode 1.x History… brings it over.",
    buttons: ["Continue offline"],
  })
}

function promptLockedEngine() {
  if (promptedLocked) return
  promptedLocked = true
  void dialog.showMessageBox({
    type: "warning",
    title: "The engine wants a password",
    message: `An OpenCode 2 engine at ${SERVER_URL} wants a password FlupCode does not have`,
    detail:
      "OpenCode 2 always runs behind a password. Stop that engine and reopen FlupCode, which starts its own, " +
      "or set OPENCODE_SERVER_PASSWORD to the password it was started with.",
    buttons: ["Continue offline"],
  })
}

/**
 * An engine this app did not start reads its plugins once, when it starts.
 *
 * One that was already listening when FlupCode wrote them is running without them, and nothing says
 * so: the chat works, while the effort menu stays empty and the Context screen captures nothing. Not
 * fatal, so it is said once and the app carries on.
 */
function promptPluginRestart() {
  if (promptedRestart) return
  promptedRestart = true
  void dialog.showMessageBox({
    type: "info",
    title: "Restart the engine to load FlupCode's plugins",
    message: "The engine was already running when FlupCode installed its plugins",
    detail:
      "An engine reads its plugins when it starts, and this one was already listening.\n\n" +
      "Until it is restarted, the effort menu and the Context screen have nothing to show.\n\n" +
      "Stop it and start it again, or close it and let FlupCode start its own.",
    buttons: ["Continue"],
  })
}

export async function ensureServer() {
  if (process.env.FLUPCODE_NO_SERVER === "1") return
  const running = await runningEngine()
  if (running.kind === "v2") {
    // An engine already running picks its plugins up on restart.
    if ((await installEnginePlugins()).changed) promptPluginRestart()
    console.info(`[flupcode] engine running: OpenCode ${running.version}`)
    return
  }
  if (running.kind === "v1") return promptLegacyEngine(running.version)
  // An OpenCode 2 engine someone else started, behind a password FlupCode was not given: starting
  // another one on its port would only fail, so say what it needs instead.
  if (await openCodeV2Locked(SERVER_URL, fetch, { headers: authHeaders() })) return promptLockedEngine()

  // The pinned binary or `FLUPCODE_OPENCODE`, never whichever `opencode` the PATH happens to hold.
  const command = await resolveOpenCodeV2().catch((cause: unknown) => {
    console.error(`[flupcode] could not get OpenCode 2: ${cause instanceof Error ? cause.message : String(cause)}`)
    return undefined
  })
  if (!command) return promptNoEngine()
  // Before the engine starts, since it reads its plugins once, at startup.
  await installEnginePlugins()

  // The engine listens privately; the proxy takes the address everything else asks for, once it is up.
  const args = ["serve", "--port", String(ENGINE_PORT), "--hostname", "127.0.0.1"]
  console.info(`[flupcode] starting the engine: ${[command, ...args].join(" ")}`)
  const secret = ensureEngineCredentials()
  // The actions plugin reads its token and profiles from the harness, so the engine is told where
  // that server answers. It is not the engine's own URL.
  const env = {
    ...process.env,
    PATH: searchPath(),
    FLUPCODE_HARNESS_SERVER_URL: HARNESS_SERVER_URL,
    FLUPCODE_BROWSER_TOKEN: harnessBrowserToken(),
  }
  // FlupCode's own database: 2.x would migrate 1.x's `opencode.db` one way, so 1.x history only
  // reaches it through the explicit import (V2-61).
  child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: openCodeV2Env({ password: secret, env }),
  })
  child.on("error", () => {
    child = undefined
  })

  for (let attempt = 0; attempt < 40; attempt++) {
    const started = await detectEngine(ENGINE_URL, fetch, { headers: authHeaders() })
    if (started.kind === "v2") {
      await serveEngine()
      console.info(`[flupcode] engine ready: OpenCode ${started.version}, for the web app too at ${SERVER_URL}`)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  promptNoEngine()
}

export async function ensureHarnessServer() {
  if (process.env.FLUPCODE_NO_SERVER === "1" || process.env.FLUPCODE_NO_HARNESS_SERVER === "1") return
  if (await isHarnessServerHealthy()) return

  const harness = resolveHarnessServer()
  if (!harness) return

  const port = new URL(HARNESS_SERVER_URL).port || "4097"
  // Windows and Linux hand the harness the key their keychain holds, so both processes open the
  // same vault. macOS gets nothing here and the harness writes its own file instead (WA-5).
  const vaultKey = vaultKeyForHarness()
  // The harness talks to the engine on the scheduler's behalf, so it gets the same Basic credential
  // the renderer uses. It starts before the engine, which is why the password is decided here.
  ensureEngineCredentials()
  const authorization = engineCredentials()
  harnessChild = spawn(harness.command, harness.args, {
    cwd: harness.cwd,
    env: {
      ...process.env,
      PATH: searchPath(),
      FLUPCODE_ENGINE_URL: SERVER_URL,
      FLUPCODE_HARNESS_PORT: port,
      FLUPCODE_BROWSER_TOKEN: harnessBrowserToken(),
      ...(authorization ? { FLUPCODE_ENGINE_AUTH: authorization } : {}),
      // The Chromium that ships beside the app, so Playwright finds it without a download of its
      // own. In development it is not packaged, and the system browser is used instead (WA-9).
      ...(app.isPackaged ? { PLAYWRIGHT_BROWSERS_PATH: join(process.resourcesPath, "browsers") } : {}),
      ...(vaultKey ? { FLUPCODE_VAULT_KEY: vaultKey } : {}),
    },
    stdio: "inherit",
    shell: process.platform === "win32",
  })
  harnessChild.on("error", () => {
    harnessChild = undefined
  })

  for (let attempt = 0; attempt < 40; attempt++) {
    if (await isHarnessServerHealthy()) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/**
 * "Import OpenCode 1.x History…" (V2-61): FlupCode's 2.x engine is stopped, the harness binary copies
 * 1.x's database into the 2.x one (read-only on the 1.x side, the previous 2.x database kept), and the
 * engine starts again, importing the copy as it does; the window shows that import's progress.
 */
export function importOpenCodeV1History() {
  return changeV2Database({
    command: ["import-v1"],
    question: "Import your OpenCode 1.x history into OpenCode 2?",
    detail:
      "FlupCode copies OpenCode 1.x's database into its own OpenCode 2 database and restarts the engine, which " +
      "imports the copy. The 1.x database is only read, never changed, and what OpenCode 2 holds now is kept: " +
      '"Undo OpenCode 1.x Import" puts it back.',
    action: "Import",
    done: (answer) => `Copied ${answer.sessions ?? 0} sessions. OpenCode 2 is importing them now.`,
  })
}

/** "Undo OpenCode 1.x Import…": FlupCode's 2.x database goes back to what it was before the import. */
export function undoOpenCodeV1Import() {
  return changeV2Database({
    command: ["rollback-import"],
    question: "Put FlupCode's OpenCode 2 database back as it was before the last import?",
    detail: "The engine restarts. The database it has now is moved aside, not deleted.",
    action: "Undo import",
    done: (answer) =>
      answer.restored ? "The previous OpenCode 2 database is back." : "OpenCode 2 starts empty again.",
  })
}

async function changeV2Database(input: {
  command: string[]
  question: string
  detail: string
  action: string
  done: (answer: Record<string, unknown>) => string
}) {
  const harness = resolveHarnessServer()
  // Only the engine this app started is FlupCode's 2.x engine on FlupCode's database; one someone else
  // runs keeps it open, and changing a database under a running engine is how it gets corrupted.
  if (!harness || (!child && (await runningEngine()).kind !== "none")) {
    await dialog.showMessageBox({
      type: "info",
      message: "FlupCode can only do this with the OpenCode 2 engine it starts",
      detail: 'Stop the engine that is running and reopen FlupCode, or use "flupcode engine import-v1" in a terminal.',
      buttons: ["OK"],
    })
    return
  }
  const confirmed = await dialog.showMessageBox({
    type: "question",
    message: input.question,
    detail: input.detail,
    buttons: [input.action, "Cancel"],
    defaultId: 0,
    cancelId: 1,
  })
  if (confirmed.response !== 0) return
  await stopEngine()
  const run = spawnSync(harness.command, [...harness.args, "engine-data", ...input.command], {
    cwd: harness.cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: searchPath() },
    shell: process.platform === "win32",
  })
  const answer = parseAnswer(run.stdout)
  await ensureServer()
  await dialog.showMessageBox(
    typeof answer.error === "string" || run.status !== 0
      ? { type: "error", message: "That did not work", detail: String(answer.error ?? run.stderr), buttons: ["OK"] }
      : { type: "info", message: input.done(answer), buttons: ["OK"] },
  )
}

function parseAnswer(stdout: string | null): Record<string, unknown> {
  const line = (stdout ?? "").trim().split("\n").at(-1) ?? ""
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Stops the engine this app started and waits until its port is free. */
async function stopEngine() {
  const running = child
  child = undefined
  if (!running || running.exitCode !== null) return
  const exited = new Promise((resolve) => running.once("exit", resolve))
  running.kill()
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))])
}

export function stopServer() {
  void proxy?.close()
  proxy = undefined
  harnessChild?.kill()
  harnessChild = undefined
  child?.kill()
  child = undefined
}
