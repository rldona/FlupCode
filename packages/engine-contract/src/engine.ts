import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { detectEngine } from "@flupcode/remote/engine-kind"
import { installOpenCodeV2 } from "./opencode-v2"

/**
 * A real engine, isolated from the machine it runs on.
 *
 * Its home, XDG folders, database, credentials and config live in a temporary folder, and its only
 * model is the stub one, so the same test gives the same answers on a laptop and in CI and never
 * touches the user's `opencode.db`. `FLUPCODE_CONTRACT_ENGINE` points the suite at another engine
 * (a released 1.x binary, or 2.x for V2-06): a command line where `{port}` is the port to listen on.
 */
export async function startEngine(input: {
  modelUrl: string
  config?: Record<string, unknown>
  /** Layered over the isolated environment. `OPENCODE_PURE: undefined` lets plugins load. */
  env?: Record<string, string | undefined>
  /** Runs once the isolated home exists and before the engine starts, e.g. to install plugins. */
  prepare?: (home: string) => Promise<void>
}) {
  // The real path: macOS hands out `/var/...`, a link to `/private/var/...`, and the engine asks for
  // an external-directory permission when a tool reads a path that is not under the one it resolved.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flupcode-contract-")))
  const home = join(root, "home")
  const project = join(root, "project")
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  await input.prepare?.(home)
  const password = crypto.randomUUID()
  const port = freePort()
  const command = await engineCommand()
  const child = Bun.spawn(
    command.map((part) => part.replaceAll("{port}", String(port))),
    {
      cwd: project,
      env: definedOnly({
        PATH: process.env.PATH ?? "",
        HOME: home,
        OPENCODE_TEST_HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local/share"),
        XDG_STATE_HOME: join(home, ".local/state"),
        XDG_CACHE_HOME: join(home, ".cache"),
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...stubConfig(input.modelUrl), ...input.config }),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_AUTOCOMPACT: "1",
        OPENCODE_AUTH_CONTENT: "{}",
        // No plugins from npm or the user: this suite is about the engine's own contract. The plugin
        // smoke test (V2-03) turns this off and installs FlupCode's plugins on purpose.
        OPENCODE_PURE: "1",
        ...input.env,
      }),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  )
  // Drained from the start so a chatty engine never blocks on a full pipe; read only if it fails.
  const stderr = new Response(child.stderr).text().catch(() => "")
  const url = `http://127.0.0.1:${port}`
  const authorization = `Basic ${btoa(`opencode:${password}`)}`
  const stop = async () => {
    if (child.exitCode === null && !child.signalCode) {
      child.kill("SIGTERM")
      const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(5000).then(() => false)])
      if (!exited) child.kill("SIGKILL")
      await child.exited
    }
    rmSync(root, { recursive: true, force: true })
  }

  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) break
    const detected = await detectEngine(url, fetch, { headers: { authorization } })
    if (detected.kind !== "none") return { url, authorization, home, project, detected, stop }
    await Bun.sleep(250)
  }
  await stop()
  const tail = (await stderr).trim().split("\n").slice(-30).join("\n")
  throw new Error(`The engine did not start at ${url}${tail ? `\n${tail}` : ""}`)
}

export type Engine = Awaited<ReturnType<typeof startEngine>>

/** The model every session uses: `stub/stub-model`, served by `startModel`. */
export const STUB_MODEL = { providerID: "stub", modelID: "stub-model" }

/**
 * Which engine line the suite targets: `v1` (default) or `v2`. Each suite runs only on its own line,
 * and the fixtures of one line live apart from the other's.
 */
export const CONTRACT_LINE = process.env.FLUPCODE_CONTRACT_LINE === "v2" ? "v2" : "v1"

async function engineCommand() {
  const configured = process.env.FLUPCODE_CONTRACT_ENGINE?.trim()
  if (configured) return configured.split(/\s+/)
  // The pinned 2.x binary from the sandbox (V2-05), fetched and verified on first use.
  if (CONTRACT_LINE === "v2") return [await installOpenCodeV2(), "serve", "--port", "{port}", "--hostname", "127.0.0.1"]
  const entry = resolve(import.meta.dir, "../../opencode/src/index.ts")
  return [process.execPath, "run", entry, "serve", "--port", "{port}", "--hostname", "127.0.0.1"]
}

function stubConfig(modelUrl: string) {
  return {
    formatter: false,
    lsp: false,
    model: `${STUB_MODEL.providerID}/${STUB_MODEL.modelID}`,
    small_model: `${STUB_MODEL.providerID}/${STUB_MODEL.modelID}`,
    provider: {
      [STUB_MODEL.providerID]: {
        name: "Stub",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "stub", baseURL: modelUrl },
        models: {
          [STUB_MODEL.modelID]: {
            name: "Stub model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
          },
        },
      },
    },
  }
}

function definedOnly(env: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

/** A port nothing listens on right now: the OS picks it, the probe lets it go. */
function freePort() {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = probe.port
  probe.stop(true)
  return port
}
