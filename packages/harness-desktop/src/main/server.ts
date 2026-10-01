import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { app, dialog, shell } from "electron"
import { detectEngine, openCodeLineOf, openCodeV2Locked } from "@flupcode/remote/engine-kind"
import { installEnginePlugins } from "@flupcode/remote/engine-plugins"
import { readOrCreateFileToken } from "./browser-token-file"
import { vaultKeyForHarness } from "./vault"

export const SERVER_URL = process.env.FLUPCODE_SERVER_URL ?? "http://127.0.0.1:4096"
export const HARNESS_SERVER_URL = process.env.FLUPCODE_HARNESS_SERVER_URL ?? "http://127.0.0.1:4097"
export const OPENCODE_DOCS = "https://opencode.ai/docs/"

let child: ChildProcess | undefined
let harnessChild: ChildProcess | undefined
let prompted = false
let promptedRestart = false
let promptedV2 = false

/**
 * The engine answers any request from any `http://localhost:*` origin, so an unsecured one lets
 * every page the machine serves drive the agent. The engine FlupCode starts gets a password for the
 * life of the app; one the user started keeps whatever they configured through the environment.
 */
const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
let password = process.env.OPENCODE_SERVER_PASSWORD

/** `base64(user:pass)` for the engine, or nothing when it needs no credentials. */
export function engineCredentials() {
  return password ? Buffer.from(`${username}:${password}`).toString("base64") : undefined
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

function repoEngineDir() {
  return join(app.getAppPath(), "..", "..", "packages", "opencode")
}

function repoHarnessDir() {
  return join(app.getAppPath(), "..", "..", "packages", "harness-server")
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

/**
 * The line the engine about to start is on, from its `--version`. A source checkout run through Bun
 * is FlupCode's 1.x engine.
 */
function engineLine(engine: { command: string; args: string[] }) {
  if (engine.args[0] === "run") return "v1"
  const version = spawnSync(engine.command, ["--version"], {
    encoding: "utf8",
    env: { ...process.env, PATH: searchPath() },
    shell: process.platform === "win32",
    timeout: 10_000,
  })
  return openCodeLineOf(version.stdout)
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

/**
 * OpenCode 2.x answers where FlupCode expects its engine: the user installed it over the 1.x
 * `opencode`, or started it by hand. The app drives it through its OpenCode 2 adapter (V2-11), but
 * none of FlupCode's plugins load on 2.x yet, so it says once what is missing and how to get a 1.x
 * engine back instead of letting the extras go quiet.
 */
function promptEngineV2(version: string, command?: string) {
  if (promptedV2) return
  promptedV2 = true
  void dialog
    .showMessageBox({
      type: "info",
      title: "Running on OpenCode 2",
      message: `FlupCode is running on OpenCode ${version}`,
      detail:
        (command
          ? `The engine started from "${command}" is OpenCode ${version}.`
          : `The engine at ${SERVER_URL} is OpenCode ${version}.`) +
        "\n\nChats, runs and routines work, but some of FlupCode's plugins do not run on OpenCode 2 yet, so permission modes and memory are unavailable.\n\n" +
        "To get them back, install OpenCode 1.x, or set FLUPCODE_OPENCODE to the path of a 1.x opencode binary, then reopen FlupCode.",
      buttons: ["Continue", "Open install docs"],
      defaultId: 0,
      cancelId: 0,
    })
    .then((result) => {
      if (result.response === 1) void shell.openExternal(OPENCODE_DOCS)
    })
}

function promptLockedEngine() {
  if (promptedV2) return
  promptedV2 = true
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
    if ((await installEnginePlugins(undefined, "v2")).changed) promptPluginRestart()
    return promptEngineV2(running.version)
  }
  // An OpenCode 2 engine someone else started, behind a password FlupCode was not given: starting
  // another one on its port would only fail, so say what it needs instead.
  if (running.kind === "none" && (await openCodeV2Locked(SERVER_URL, fetch, { headers: authHeaders() })))
    return promptLockedEngine()
  if (running.kind === "v1") {
    if ((await installEnginePlugins(undefined, "v1")).changed) promptPluginRestart()
    return
  }

  const engine = resolveEngine()
  if (!engine) {
    promptInstall()
    return
  }
  // Before the engine starts, since it reads its plugins once, at startup: the set its line loads.
  await installEnginePlugins(undefined, engineLine(engine))

  console.info(`[flupcode] starting the engine: ${[engine.command, ...engine.args].join(" ")}`)
  ensureEngineCredentials()
  child = spawn(engine.command, engine.args, {
    cwd: engine.cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    // The actions plugin reads its token and profiles from the harness, so the engine is told where
    // that server answers. It is not the engine's own URL.
    env: {
      ...process.env,
      PATH: searchPath(),
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
      FLUPCODE_HARNESS_SERVER_URL: HARNESS_SERVER_URL,
      FLUPCODE_BROWSER_TOKEN: harnessBrowserToken(),
    },
  })
  child.on("error", () => {
    child = undefined
  })

  for (let attempt = 0; attempt < 40; attempt++) {
    const started = await runningEngine()
    if (started.kind === "v1") {
      console.info(`[flupcode] engine ready: OpenCode ${started.version ?? "unknown version"}`)
      return
    }
    if (started.kind === "v2") {
      console.info(`[flupcode] engine ready: OpenCode ${started.version}`)
      return promptEngineV2(started.version, engine.command)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  promptInstall()
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

export function stopServer() {
  harnessChild?.kill()
  harnessChild = undefined
  child?.kill()
  child = undefined
}
