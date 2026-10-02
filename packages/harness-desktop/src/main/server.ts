import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { homedir, release } from "node:os"
import { delimiter, join } from "node:path"
import { BrowserWindow, app, clipboard, dialog } from "electron"
import { diagnosticsBundle } from "@flupcode/remote/diagnostics"
import { detectEngine, openCodeV2Locked } from "@flupcode/remote/engine-kind"
import { engineConfigDir, installEnginePlugins } from "@flupcode/remote/engine-plugins"
import { startEngineProxy } from "@flupcode/remote/engine-proxy"
import {
  engineEnvBesideHarness,
  harnessHealthy,
  harnessServerEnv,
  resolveHarnessServer,
} from "@flupcode/remote/harness-host"
import { openCodeV2Env, OPENCODE_V2_VERSION, resolveOpenCodeV2 } from "@flupcode/remote/opencode-v2"
import { portInUse, reapOrphan, superviseChild, type ChildFailure, type Supervisor } from "@flupcode/remote/supervisor"
import { readFileToken, readOrCreateFileToken, tokenFileDir } from "./browser-token-file"
import { vaultKeyForHarness } from "./vault"

export const SERVER_URL = process.env.FLUPCODE_SERVER_URL ?? "http://127.0.0.1:4096"
export const HARNESS_SERVER_URL = process.env.FLUPCODE_HARNESS_SERVER_URL ?? "http://127.0.0.1:4097"
/**
 * Where an OpenCode 2 engine this app starts listens (2.1). `SERVER_URL` is the engine proxy in front
 * of it, which signs in for the window, the harness and FlupCode's web app alike: 2.x always asks for a
 * password, and a web page has no way to send one.
 */
const ENGINE_PORT = Number(process.env.FLUPCODE_ENGINE_PORT ?? 4098)
const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`

/**
 * The engine and the harness this app started, each kept alive by a supervisor (HE-03): restarted
 * when it stops, its output in `<userData>/logs`, its pid in `<userData>` so the next launch can
 * stop one this launch leaves behind.
 */
let engine: Supervisor | undefined
let harness: Supervisor | undefined
let proxy: Awaited<ReturnType<typeof startEngineProxy>> | undefined
let prompted = false
let promptedForeign = false
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

export function isHarnessServerHealthy() {
  return harnessHealthy(HARNESS_SERVER_URL)
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

function harnessServer(): { command: string; args: string[]; cwd?: string } | undefined {
  // `bun build --compile` writes `flupcode-harness.exe` on Windows whatever the outfile says, so the
  // packaged binary is looked for under the name it actually has. Asking for the wrong one is how
  // 1.8.0 shipped a Windows app with no server at all, silently: electron-builder skipped a resource
  // that did not exist and the build stayed green.
  const packagedName = process.platform === "win32" ? "flupcode-harness.exe" : "flupcode-harness"
  const resolved = resolveHarnessServer({
    binaries: [join(process.resourcesPath, "harness-server", packagedName)],
    checkout: repoHarnessDir(),
  })
  if (resolved) return resolved
  if (commandExists("flupcode-harness")) return { command: "flupcode-harness", args: [] }
  return undefined
}

/**
 * FlupCode has no engine, and the dialog says why: the download, a port another program holds, or
 * the engine's own last words when it stopped as it started. Its log has the rest, and so does the
 * diagnostics the dialog offers to copy.
 */
function promptNoEngine(problem: { message: string; detail: string }) {
  console.error(`[flupcode] no engine: ${problem.message}`)
  if (prompted) return
  prompted = true
  void dialog
    .showMessageBox({
      type: "warning",
      title: "OpenCode 2 is not available",
      message: problem.message,
      detail: `${problem.detail}\n\nFlupCode is offline for now.`,
      buttons: ["Copy Diagnostics", "Continue offline"],
      defaultId: 1,
      cancelId: 1,
    })
    .then((result) => {
      if (result.response === 0) void copyDiagnostics()
    })
}

/** What a child's failure says in a dialog: the reason, then the last lines it printed. */
function failureDetail(failure: ChildFailure | undefined, hint: string) {
  const lines = failure?.lastLines.slice(-6) ?? []
  return [hint, ...(lines.length ? ["", "Its last output:", ...lines] : [])].join("\n")
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
 * An engine this app did not start may run without FlupCode's plugins: they live in FlupCode's own
 * folder and only an engine FlupCode (or `flupcode`) starts is told about them (HE-04).
 *
 * Nothing else says so: the chat works, while the effort menu stays empty and the Context screen
 * captures nothing. Not fatal, so it is said once, when the plugins were just written, and the app
 * carries on.
 */
function promptForeignEngine() {
  if (promptedForeign) return
  promptedForeign = true
  void dialog.showMessageBox({
    type: "info",
    title: "FlupCode's plugins load only in an engine FlupCode starts",
    message: "FlupCode found an engine already running",
    detail:
      "FlupCode keeps its engine plugins in its own folder, and only an engine started by FlupCode or flupcode loads them.\n\n" +
      "If you started this one yourself, the effort menu and the Context screen have nothing to show with it.\n\n" +
      "Close it and reopen FlupCode, which starts its own.",
    buttons: ["Continue"],
  })
}

export async function ensureServer() {
  if (process.env.FLUPCODE_NO_SERVER === "1") return
  const running = await runningEngine()
  if (running.kind === "v2") {
    // An engine started by hand never loads FlupCode's plugins; the old global copies still go.
    if ((await installEnginePlugins()).changed) promptForeignEngine()
    console.info(`[flupcode] engine running: OpenCode ${running.version}`)
    return
  }
  if (running.kind === "v1") return promptLegacyEngine(running.version)
  // An OpenCode 2 engine someone else started, behind a password FlupCode was not given: starting
  // another one on its port would only fail, so say what it needs instead.
  if (await openCodeV2Locked(SERVER_URL, fetch, { headers: authHeaders() })) return promptLockedEngine()

  // The pinned binary or `FLUPCODE_OPENCODE`, never whichever `opencode` the PATH happens to hold.
  const resolved = await resolveOpenCodeV2().then(
    (command) => ({ command }),
    (cause: unknown) => ({ error: cause instanceof Error ? cause.message : String(cause) }),
  )
  if ("error" in resolved) {
    console.error(`[flupcode] could not get OpenCode 2: ${resolved.error}`)
    return promptNoEngine({
      message: `FlupCode could not download OpenCode ${OPENCODE_V2_VERSION}`,
      detail:
        `${resolved.error}\n\nFlupCode downloads its engine once and keeps it in its cache. Check the connection ` +
        "and reopen FlupCode, or name an OpenCode 2 binary with FLUPCODE_OPENCODE.",
    })
  }
  const command = resolved.command
  // Before the engine starts, since it reads its plugins once, at startup; `openCodeV2Env` names them.
  await installEnginePlugins()

  // An engine an earlier launch left running holds the port behind a password nobody has any more.
  // Only the one this app recorded, and only while it still answers as OpenCode 2, is stopped.
  const orphan = await reapOrphan({
    dir: app.getPath("userData"),
    name: "engine",
    probe: async () => (await openCodeV2Locked(ENGINE_URL)) || (await detectEngine(ENGINE_URL)).kind === "v2",
  })
  if (orphan.reaped) console.info(`[flupcode] stopped the engine an earlier launch left running (pid ${orphan.pid})`)
  if (await portInUse(ENGINE_PORT))
    return promptNoEngine({
      message: `Port ${ENGINE_PORT}, where FlupCode starts its engine, is taken by another program`,
      detail:
        "Close the program that holds it and reopen FlupCode, or start FlupCode with FLUPCODE_ENGINE_PORT set to a free port.",
    })

  // The engine listens privately; the proxy takes the address everything else asks for, once it is up.
  const args = ["serve", "--port", String(ENGINE_PORT), "--hostname", "127.0.0.1"]
  console.info(`[flupcode] starting the engine: ${[command, ...args].join(" ")}`)
  const secret = ensureEngineCredentials()
  // The actions plugin reads its profiles from the harness, so the engine is told where that server
  // answers. It is not the engine's own URL. No harness secret goes with it: an agent's shell inherits
  // the engine's environment, and the plugins read their own scoped token from its file (TI-10).
  const env = engineEnvBesideHarness({ ...process.env, PATH: searchPath() }, HARNESS_SERVER_URL)
  // FlupCode's own database: 2.x would migrate 1.x's `opencode.db` one way, so 1.x history only
  // reaches it through the explicit import (V2-61). A restart reuses the same password, so the proxy
  // and the harness keep signing in.
  engine = superviseChild({
    name: "engine",
    command,
    args,
    options: { shell: process.platform === "win32", env: openCodeV2Env({ password: secret, env }) },
    dir: app.getPath("userData"),
    ready: async () => (await detectEngine(ENGINE_URL, fetch, { headers: authHeaders() })).kind === "v2",
    echo: !app.isPackaged,
    onChange: announceChildren,
  })
  const state = await engine.start()
  if (state.phase === "running") {
    await serveEngine()
    console.info(`[flupcode] engine ready, for the web app too at ${SERVER_URL}`)
    return
  }
  promptNoEngine({
    message: `OpenCode ${OPENCODE_V2_VERSION} ${state.failure?.message ?? "did not start"}`,
    detail: failureDetail(state.failure, `Its log is at ${state.log}.`),
  })
}

export async function ensureHarnessServer() {
  if (process.env.FLUPCODE_NO_SERVER === "1" || process.env.FLUPCODE_NO_HARNESS_SERVER === "1") return

  // A harness an earlier launch left running has a password and token this launch did not give it.
  const orphan = await reapOrphan({ dir: app.getPath("userData"), name: "harness", probe: isHarnessServerHealthy })
  if (orphan.reaped) console.info(`[flupcode] stopped the harness an earlier launch left running (pid ${orphan.pid})`)
  if (await isHarnessServerHealthy()) return

  const resolved = harnessServer()
  if (!resolved) return

  const port = new URL(HARNESS_SERVER_URL).port || "4097"
  // Windows and Linux hand the harness the key their keychain holds, so both processes open the
  // same vault. macOS gets nothing here and the harness writes its own file instead (WA-5).
  const vaultKey = vaultKeyForHarness()
  // The harness talks to the engine on the scheduler's behalf, so it gets the same Basic credential
  // the renderer uses. It starts before the engine, which is why the password is decided here.
  ensureEngineCredentials()
  const authorization = engineCredentials()
  harness = superviseChild({
    name: "harness",
    command: resolved.command,
    args: resolved.args,
    options: {
      cwd: resolved.cwd,
      env: harnessServerEnv({
        env: { ...process.env, PATH: searchPath() },
        engineUrl: SERVER_URL,
        port,
        authorization,
        browserToken: harnessBrowserToken(),
        vaultKey,
        // The Chromium that ships beside the app, so Playwright finds it without a download of its
        // own. In development it is not packaged, and the system browser is used instead (WA-9).
        ...(app.isPackaged ? { browsers: join(process.resourcesPath, "browsers") } : {}),
      }),
      shell: process.platform === "win32",
    },
    dir: app.getPath("userData"),
    ready: isHarnessServerHealthy,
    echo: !app.isPackaged,
    onChange: announceChildren,
  })
  const state = await harness.start()
  if (state.phase === "running") return
  void dialog.showMessageBox({
    type: "warning",
    title: "The harness server did not start",
    message: `FlupCode's harness server ${state.failure?.message ?? "did not start"}`,
    detail: failureDetail(
      state.failure,
      `Runs, Workflows, Routines and Artifacts need it; chat with the engine still works. Its log is at ${state.log}.`,
    ),
    buttons: ["Copy Diagnostics", "Continue"],
    defaultId: 1,
    cancelId: 1,
  }).then((result) => {
    if (result.response === 0) void copyDiagnostics()
  })
}

/** What the window shows about the engine and the harness: restarting, failed, or nothing. */
export function childStates() {
  return [harness?.state(), engine?.state()].filter((state) => state !== undefined)
}

function announceChildren() {
  const states = childStates()
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("flupcode:children-changed", states))
}

/** "Restart" on the banner of a child the supervisor gave up on. */
export async function restartChild(name: unknown) {
  const target = name === "engine" ? engine : name === "harness" ? harness : undefined
  if (!target || target.state().phase !== "failed") return
  const state = await target.start()
  if (target === engine && state.phase === "running") await serveEngine()
}

/**
 * The diagnostics "Copy Diagnostics" puts on the clipboard (HE-03): versions, ports, both children and
 * the end of their logs, the engine's config, with every secret this app holds taken out.
 */
export async function diagnostics() {
  const running = await runningEngine()
  const configDir = tokenFileDir()
  return diagnosticsBundle({
    title: "FlupCode diagnostics",
    versions: {
      FlupCode: app.getVersion(),
      "OpenCode (pinned)": OPENCODE_V2_VERSION,
      "OpenCode (running)": running.kind === "none" ? "none answering" : `${running.kind} ${running.version ?? ""}`.trim(),
      Electron: process.versions.electron,
      Chromium: process.versions.chrome,
      Node: process.versions.node,
      OS: `${process.platform} ${release()} ${process.arch}`,
      packaged: String(app.isPackaged),
    },
    ports: { "engine (for the app)": SERVER_URL, "engine (private)": ENGINE_URL, harness: HARNESS_SERVER_URL },
    children: childStates(),
    configs: ["opencode.json", "opencode.jsonc"].map((file) => ({
      label: "OpenCode",
      file: join(engineConfigDir(), file),
    })),
    env: process.env,
    secrets: [
      password,
      browserToken,
      readFileToken(join(configDir, "browser-token")),
      readFileToken(join(configDir, "plugin-token")),
      readFileToken(join(configDir, "vault-key")),
      process.env.FLUPCODE_VAULT_KEY,
      vaultKeyForHarness(),
    ],
  })
}

export async function copyDiagnostics() {
  clipboard.writeText(await diagnostics())
  return true
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
  const resolved = harnessServer()
  // Only the engine this app started is FlupCode's 2.x engine on FlupCode's database; one someone else
  // runs keeps it open, and changing a database under a running engine is how it gets corrupted.
  if (!resolved || (!engine && (await runningEngine()).kind !== "none")) {
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
  const run = spawnSync(resolved.command, [...resolved.args, "engine-data", ...input.command], {
    cwd: resolved.cwd,
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

/** Stops the engine this app started, for good, and waits until its port is free. */
async function stopEngine() {
  await engine?.stop()
  engine = undefined
}

export function stopServer() {
  void proxy?.close()
  proxy = undefined
  void harness?.stop()
  void engine?.stop()
}
