/**
 * The replay corpus (AH-B04): what one past session asked, redacted, so it can be asked again.
 *
 * A fixture keeps the *inputs* only — the user's prompts in order, the agent and model they went to,
 * the project folder they were asked in, its commit, and an optional verify command. No assistant
 * answer and no tool output is ever written: the replay regenerates those, and they are where a
 * transcript carries the most private material.
 *
 * Export is opt-in and local: a person names the session, the file lands in the ignored corpus
 * folder, and nothing is committed unless somebody reviews it and adds it on purpose.
 */

import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Engine } from "../engine"
import { redactText } from "../adaptive/redaction"

export type ReplayModel = { providerID: string; modelID: string; variant?: string }

export type ReplayFixture = {
  version: 1
  id: string
  /** The project folder, with the home directory written as `~`. */
  directory: string
  /** The commit the session started from, when the folder was a git checkout. */
  commit?: string
  agent?: string
  model?: ReplayModel
  prompts: string[]
  /** A shell command run in the replay's folder after the last turn; exit 0 means verified. */
  verify?: string
  source?: { sessionID: string; exportedAt: number }
}

/** The corpus folder: ignored by git apart from its README and the synthetic example. */
export const REPLAY_FIXTURES_DIR = join(import.meta.dir, "..", "..", "fixtures", "replay")

/** Reads one session from the engine and returns it as a redacted fixture; nothing is written here. */
export async function exportSession(input: {
  engine: Pick<Engine, "describeSession" | "messages">
  sessionID: string
  id?: string
  directory?: string
  verify?: string
  secrets?: readonly string[]
  now?: number
}): Promise<ReplayFixture> {
  const session = await input.engine.describeSession(input.sessionID)
  if (!session) throw new Error(`The engine has no session ${input.sessionID}`)
  const directory = input.directory ?? session.directory
  const messages = await input.engine.messages(input.sessionID)
  const users = messages.filter((message) => message.info?.role === "user")
  // Only what the person typed: synthetic parts are file reads and reminders the engine added.
  const prompts = users
    .map((message) =>
      (message.parts ?? [])
        .filter((part) => part.type === "text" && part.text && !part.synthetic && !part.ignored)
        .map((part) => part.text)
        .join("\n")
        .trim(),
    )
    .filter((text) => text.length > 0)
    .map((text) => redactReplayText(text, input.secrets))
  if (prompts.length === 0) throw new Error(`Session ${input.sessionID} has no user prompt to export`)
  const first = users[0]?.info
  const model = first?.model?.providerID && first.model.modelID ? first.model : undefined
  const commit = gitHead(directory)
  const verify = input.verify?.trim()
  return {
    version: 1,
    id: fixtureID(input.id ?? input.sessionID),
    directory: redactReplayText(directory, input.secrets),
    ...(commit ? { commit } : {}),
    ...(first?.agent ? { agent: first.agent } : {}),
    ...(model
      ? {
          model: {
            providerID: model.providerID!,
            modelID: model.modelID!,
            ...(model.variant ? { variant: model.variant } : {}),
          },
        }
      : {}),
    prompts,
    ...(verify ? { verify: redactReplayText(verify, input.secrets) } : {}),
    source: { sessionID: input.sessionID, exportedAt: input.now ?? Date.now() },
  }
}

/**
 * The shared secret redaction, plus absolute home paths written as `~`.
 *
 * A home path names the person (`/Users/jane`) and says nothing a replay needs: the folder is
 * expanded back against the replaying machine's own home.
 */
export function redactReplayText(text: string, secrets: readonly string[] = []) {
  const home = homedir()
  const own = home.length > 1 ? text.split(home).join("~") : text
  return redactText(own, secrets)
    .replace(/(?<![\w.~-])\/(?:Users|home)\/[^/\s"'`]+/g, "~")
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s"'`]+/g, "~")
}

/** A fixture's folder on this machine: `~` is this machine's home. */
export function fixtureDirectory(fixture: ReplayFixture) {
  if (fixture.directory === "~") return homedir()
  if (fixture.directory.startsWith("~/")) return join(homedir(), fixture.directory.slice(2))
  return fixture.directory
}

/** Every fixture under a folder (or the one file named), sorted by id; a malformed one fails by name. */
export async function loadFixtures(path: string): Promise<ReplayFixture[]> {
  if (!existsSync(path)) throw new Error(`No fixtures at ${path}`)
  const files = statSync(path).isDirectory()
    ? readdirSync(path)
        .filter((name) => name.endsWith(".json"))
        .map((name) => join(path, name))
    : [path]
  const fixtures = await Promise.all(
    files.map(async (file) => {
      const parsed = parseFixture(
        await Bun.file(file)
          .json()
          .catch(() => undefined),
      )
      if (typeof parsed === "string") throw new Error(`${file}: ${parsed}`)
      return parsed
    }),
  )
  return fixtures.toSorted((a, b) => a.id.localeCompare(b.id))
}

/** A fixture, or the reason it is not one. */
export function parseFixture(value: unknown): ReplayFixture | string {
  if (!isPlainObject(value)) return "not a JSON object"
  if (value.version !== 1) return "unknown fixture version"
  if (typeof value.id !== "string" || !value.id) return "missing id"
  if (typeof value.directory !== "string" || !value.directory) return "missing directory"
  if (!Array.isArray(value.prompts) || value.prompts.length === 0) return "no prompts"
  if (!value.prompts.every((prompt) => typeof prompt === "string" && prompt.length > 0)) return "a prompt is not text"
  if (value.commit !== undefined && typeof value.commit !== "string") return "commit is not text"
  if (value.agent !== undefined && typeof value.agent !== "string") return "agent is not text"
  if (value.verify !== undefined && typeof value.verify !== "string") return "verify is not text"
  const model = value.model === undefined ? undefined : modelFrom(value.model)
  if (value.model !== undefined && !model) return "model needs providerID and modelID"
  return {
    version: 1,
    id: value.id,
    directory: value.directory,
    ...(value.commit ? { commit: value.commit } : {}),
    ...(value.agent ? { agent: value.agent } : {}),
    ...(model ? { model } : {}),
    prompts: value.prompts,
    ...(value.verify ? { verify: value.verify } : {}),
  }
}

function modelFrom(value: unknown): ReplayModel | undefined {
  if (!isPlainObject(value)) return undefined
  if (typeof value.providerID !== "string" || typeof value.modelID !== "string") return undefined
  if (!value.providerID || !value.modelID) return undefined
  return {
    providerID: value.providerID,
    modelID: value.modelID,
    ...(typeof value.variant === "string" && value.variant ? { variant: value.variant } : {}),
  }
}

/** The checkout's HEAD, when the folder is one; a replay compares it with its own. */
export function gitHead(directory: string) {
  if (!existsSync(directory)) return undefined
  const result = Bun.spawnSync(["git", "-C", directory, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" })
  if (result.exitCode !== 0) return undefined
  const head = result.stdout.toString().trim()
  return /^[0-9a-f]{40,64}$/.test(head) ? head : undefined
}

/** A file-safe id: the fixture's name on disk. */
function fixtureID(value: string) {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "session"
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
