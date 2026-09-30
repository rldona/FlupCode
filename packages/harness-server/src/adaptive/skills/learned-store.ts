/**
 * The learned-skill store: the one place a learned file is written (FH-040).
 *
 * The engine loads skills from disk, and a name collision silently changes which skill the model
 * sees; human-authored skills share the same tree. So the store is deliberately narrow: it writes
 * only under the learned root, only with the `self-authored` marker, never over a file that lacks it
 * and never under a name a human skill already uses. The root itself is a non-hidden subdirectory of
 * the folder the engine already scans for nested `SKILL.md` files with `dot: false`, verified against
 * the real scanner (ADR-0019 §1), so a learned skill loads like any other. The archive and the
 * snapshots live outside `skills/` so they are never re-loaded.
 *
 * Everything is written atomically through `temp + rename`: an interrupted install leaves a folder
 * with no `SKILL.md` — invisible to both scanners — and a non-`.md` temp file, never a truncated
 * skill. The `.ledger.jsonl` is append-only and the `.versions/*.txt` snapshots are bounded by
 * `SNAPSHOT_KEEP`.
 *
 * A repository can commit a learned-looking folder, so neither its files nor its marker are trusted.
 * No file is ever written through: temps get a fresh exclusive name, the ledger is opened without
 * following links, and a folder holding a symlink or a special file is refused whole. The marker only
 * says "learned"; that the harness wrote it is proved by the sidecar's `provenance`, an HMAC under the
 * install's key that a repository cannot forge, and only a verified skill is ever changed or moved.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"
import { NAME, skillReport } from "../../skills"
import { parseFrontmatter, serialiseFrontmatter } from "../../frontmatter"

/** The frontmatter field that marks a skill as the harness's own; a human skill never has it. */
export const SELF_AUTHORED_FIELD = "self-authored"
export const SIDECAR_FILE = ".sidecar.json"
export const LEDGER_FILE = ".ledger.jsonl"
export const VERSIONS_DIR = ".versions"
export const SKILL_FILE = "SKILL.md"

/** How many pre-patch snapshots a learned skill keeps; the config mirror is `learning.snapshotKeep`. */
export const SNAPSHOT_KEEP = 5

export type SkillState = "probation" | "mature" | "stale" | "archived" | "merged"

export type SkillUsage = { load: number; view: number; patch: number; opportunities: number }

const ZERO_USAGE: SkillUsage = { load: 0, view: 0, patch: 0, opportunities: 0 }

export type SkillSource = {
  projectID: string
  episodeID?: string
  proposalID?: string
  decisionID?: string
}

export type SkillSidecar = {
  name: string
  version: number
  contentHash: string
  state: SkillState
  createdBy: string
  createdAt: number
  updatedAt: number
  source: SkillSource
  evidenceRefs: string[]
  modelVersion?: string
  /**
   * Real use (AH-F02): `load` counts the distinct real sessions that ran the engine's `skill` tool on
   * it and `opportunities` the distinct real sessions observed since install. `view`/`patch` are the
   * harness's own re-reads and rewrites.
   */
  usage: SkillUsage
  /** When a real session last ran the engine's `skill` tool on it; absent means never. */
  lastUsedAt?: number
  /** Real sessions closed since its last use (or since install or patch); the archive hint reads it. */
  sessionsSinceUse: number
  /**
   * The most recent real sessions already folded into `usage`, newest last and bounded by
   * `COUNTED_SESSIONS_KEEP`. A session closes once per episode, so a later episode of the same session
   * is folded again only when it turns an unused session into a used one.
   */
  countedSessions?: CountedSession[]
  /**
   * Which signal `usage` measures. Only `engine` is written; a sidecar without it predates AH-F02 and
   * its `load`/`opportunities` counted suggestions, so the read migrates them to zero.
   */
  usageSource: "engine"
  /**
   * HMAC over the folder name and `contentHash` under the install's key: what makes this skill the
   * harness's own. A sidecar without a valid one is never trusted, so the skill is read-only.
   */
  provenance?: string
}

export type CountedSession = { id: string; used: boolean }

/** How many counted sessions a sidecar remembers; duplicates arrive close together, not days apart. */
export const COUNTED_SESSIONS_KEEP = 32

export type LedgerEvent =
  | { at: number; event: "created"; version: number; contentHash: string; proposalID?: string; reason: string }
  | { at: number; event: "patched"; version: number; from: string; to: string; proposalID?: string }
  | { at: number; event: "usage"; kind: "load" | "view" | "patch"; total: number }
  | { at: number; event: "state"; from: SkillState; to: SkillState; reason: string }
  | { at: number; event: "archived"; reason: string }
  | { at: number; event: "disabled" | "enabled"; reason: string }

export type LearnedRoots = { learned: string; archive: string; disabled: string }

/**
 * Where a project's learned skills, their archive and the ones a person disabled live.
 *
 * The learned root is a non-hidden subdirectory inside the folder the engine scans; the archive and
 * the disabled root are siblings of that folder, outside `skills/`, so they are never loaded. All are
 * overridable for tests through the environment, which is the only way a test can keep its projects
 * out of the real home.
 */
export function learnedRoots(projectID: string, env: NodeJS.ProcessEnv = process.env): LearnedRoots {
  const base = join(projectID, ".opencode")
  return {
    learned: env.FLUPCODE_ADAPTIVE_LEARNED_ROOT?.trim() || join(base, "skills", "flupcode-learned"),
    archive: env.FLUPCODE_ADAPTIVE_LEARNED_ARCHIVE?.trim() || join(base, "flupcode-learned-archive"),
    disabled: env.FLUPCODE_ADAPTIVE_LEARNED_DISABLED?.trim() || join(base, "flupcode-learned-disabled"),
  }
}

export type LearnedWriteRejection =
  | "invalid-name"
  | "no-project"
  | "path-escape"
  | "not-a-directory"
  | "not-self-authored"
  /** A learned-looking skill whose provenance does not verify: the harness did not write it. */
  | "unverified"
  /** The skill folder holds a symlink, a special file or a hard link; nothing in it is touched. */
  | "unsafe-entry"
  | "name-collision"
  | "not-found"
  | "archive-exists"
  /** Moving the skill back would land on a learned skill that already uses its name. */
  | "exists"
  | "disabled"
  | "write-failed"

export type LearnedWriteResult =
  | { ok: true; path: string; version: number; contentHash: string; state: SkillState }
  | { ok: false; reason: LearnedWriteRejection }

export type LearnedArchiveResult = { ok: true; path: string } | { ok: false; reason: LearnedWriteRejection }

export type LearnedSidecarResult = { ok: true; sidecar: SkillSidecar } | { ok: false; reason: LearnedWriteRejection }

/**
 * A sidecar-only change: the curator moves `state` and the use fields on an existing learned skill
 * without rewriting the body. A missing sidecar is reconstructed from the file as PROBATION v1
 * rather than failing, which is the defensive read ADR-0019 §3 asks for.
 */
export type LearnedSidecarUpdate = {
  projectID: string
  name: string
  state?: SkillState
  usage?: SkillUsage
  lastUsedAt?: number
  sessionsSinceUse?: number
  countedSessions?: CountedSession[]
  /** Ledger events appended after the sidecar is written, in order. */
  events?: LedgerEvent[]
  at?: number
}

export type LearnedWriteInput = {
  projectID: string
  name: string
  description: string
  body: string
  source?: Omit<SkillSource, "projectID">
  evidenceRefs?: string[]
  modelVersion?: string
  reason?: string
  at?: number
}

export type LearnedStore = {
  roots(projectID: string): LearnedRoots
  /** The only writer of a learned skill: create on first write, patch on the next. */
  write(input: LearnedWriteInput): LearnedWriteResult
  /**
   * Moves a learned skill out of `skills/`; a move, never a delete. `security: true` marks a
   * reverse-collision repair, which runs even with learning off: it is a security move, not a learning
   * write (ADR-0022 §4). Every other archive stays fail-closed behind the switch.
   */
  archive(input: { projectID: string; name: string; reason: string; at?: number; security?: boolean }): LearnedArchiveResult
  /**
   * A person's moves (AH-E04), taken from the Skills screen behind the artifacts bearer. `disable`
   * moves a learned skill out of `skills/` into the disabled root, so no new session loads it;
   * `enable` moves it back; `retire` archives it from either place. They are not gated by the
   * learning switch: the switch stops the loop's writes, and these are a person deciding about a
   * skill they already approved — turning learning off must never take away the way to unload one.
   */
  disable(input: { projectID: string; name: string; at?: number }): LearnedArchiveResult
  enable(input: { projectID: string; name: string; at?: number }): LearnedArchiveResult
  retire(input: { projectID: string; name: string; at?: number }): LearnedArchiveResult
  /** The verified skills in the disabled root, with their sidecars. */
  listDisabled(projectID: string): Array<{ name: string; description: string; sidecar: SkillSidecar }>
  /** Changes the sidecar (lifecycle state, usage counters) without touching the skill body. */
  updateSidecar(input: LearnedSidecarUpdate): LearnedSidecarResult
  readSidecar(projectID: string, name: string): SkillSidecar | undefined
  /**
   * The body and description of a learned skill, or `undefined` when absent or not verified. It reads
   * the learned root unless `where` names the disabled one.
   */
  read(
    projectID: string,
    name: string,
    where?: "learned" | "disabled",
  ): { name: string; description: string; body: string } | undefined
}

const inside = (path: string, root: string) => path === root || path.startsWith(root + sep)

const safeRealpath = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Whether `path` — which may not exist — resolves inside `root`, comparing real paths so an
 * intermediate symlink cannot escape. The nearest existing ancestor decides; `root` is expected to
 * already exist, so its real path is the one compared against.
 */
function resolvesInside(path: string, root: string): boolean {
  const realRoot = safeRealpath(root)
  let at = path
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(at)) return inside(safeRealpath(at), realRoot)
    const up = dirname(at)
    if (up === at) return false
    at = up
  }
  return false
}

/** An absolute, existing, writable directory, or the project guard rejects before anything is made. */
function usableProject(projectID: string): boolean {
  if (!projectID || !isAbsolute(projectID)) return false
  try {
    if (!statSync(projectID).isDirectory()) return false
    accessSync(projectID, constants.W_OK)
    return true
  } catch {
    return false
  }
}

const lstatOrUndefined = (path: string) => {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

/**
 * Why a learned or archive root may not be used, or `undefined` when it may.
 *
 * `resolvesInside` compares the root against itself, so a project whose `.opencode` — or `skills`, or
 * `flupcode-learned` — is a symlink to the global config still "contains" the write while landing it
 * in the link's target, outside the project. The root is therefore required to be lexically inside the
 * project, every existing component from the project down to it must be a real directory rather than a
 * link, and the real path of the resolved root must still land inside the real project.
 */
function rootRejection(projectID: string, root: string): LearnedWriteRejection | undefined {
  const path = relative(projectID, root)
  if (!path || path.startsWith("..") || isAbsolute(path)) return "path-escape"
  let at = projectID
  for (const component of path.split(sep)) {
    at = join(at, component)
    const stats = lstatOrUndefined(at)
    // A component that does not exist yet is safe to create; a real path check follows the write.
    if (!stats) continue
    if (stats.isSymbolicLink()) return "path-escape"
    if (!stats.isDirectory()) return "not-a-directory"
  }
  return resolvesInside(root, projectID) ? undefined : "path-escape"
}

/**
 * Why the files inside a skill folder may not be touched, or `undefined` when they may.
 *
 * The root checks stop at the folder, but a committed folder can hold links of its own: a
 * `.ledger.jsonl` or `.versions/<hash>.txt` pointing at a file outside the project would be appended
 * to or replaced. So every entry of the folder and of `.versions` must be a regular file with one link
 * (or a real directory); anything else refuses the whole folder rather than skipping one file.
 */
function folderRejection(skillDir: string): LearnedWriteRejection | undefined {
  const stats = lstatOrUndefined(skillDir)
  if (!stats) return undefined
  if (stats.isSymbolicLink()) return "unsafe-entry"
  if (!stats.isDirectory()) return "not-a-directory"
  const unsafe = (dir: string): boolean => {
    try {
      return readdirSync(dir).some((entry) => {
        const entryStats = lstatSync(join(dir, entry))
        if (entryStats.isFile()) return entryStats.nlink > 1
        if (!entryStats.isDirectory()) return true
        return dir === skillDir && entry === VERSIONS_DIR && unsafe(join(dir, entry))
      })
    } catch {
      return true
    }
  }
  return unsafe(skillDir) ? "unsafe-entry" : undefined
}

/** The ledger reason of a move a person asked for from the Skills screen (AH-E04). */
export const HUMAN_REASON = "human"

/** A store built without the install's key signs with this one, so its skills verify only in-process. */
const EPHEMERAL_KEY = randomBytes(32)

/** The domain tag keeps a provenance HMAC distinct from every other use of the install's key. */
const provenanceOf = (key: Buffer, name: string, contentHash: string): Buffer =>
  createHmac("sha256", key).update(`flupcode-learned-skill\0${name}\0${contentHash}`).digest()

/** The marker is read from the frontmatter, not the path, so it survives a move. */
const isSelfAuthored = (text: string): boolean => parseFrontmatter(text).fields[SELF_AUTHORED_FIELD] === true

/** A skill file written by this store: the `name`, an optional description, and the marker. */
export function serialiseLearnedSkill(input: { name: string; description: string; body: string }): string {
  return serialiseFrontmatter({
    fields: {
      name: input.name,
      ...(input.description.trim() ? { description: input.description.trim() } : {}),
      [SELF_AUTHORED_FIELD]: true,
    },
    prompt: input.body,
  })
}

export const contentHashOf = (text: string): string => createHash("sha256").update(text).digest("hex")

/**
 * Write through a temp file and rename: the rename is what makes the file visible.
 *
 * The temp name is random and created exclusively (`wx`), so a planted `<file>.tmp` link is never
 * written through, and the rename replaces the directory entry rather than following it.
 */
function atomicWrite(path: string, text: string): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`)
  writeFileSync(temp, text, { flag: "wx" })
  try {
    renameSync(temp, path)
  } catch (cause) {
    rmSync(temp, { force: true })
    throw cause
  }
}

/**
 * Append one ledger event in a single `O_APPEND` write.
 *
 * The old body read the whole file and rewrote it, so a log of `n` events cost `O(n²)`. The file is
 * append-only and every event is one complete line, so a real append keeps the format and the cost
 * linear. A crash mid-line can leave a partial trailing line; a reader that parses line by line drops
 * it, which is the accepted cost of not rewriting every prior line on each append.
 */
function appendLedger(path: string, event: LedgerEvent): void {
  // `O_NOFOLLOW` refuses a symlinked ledger and `O_NONBLOCK` keeps a planted FIFO from hanging the
  // open; the `fstat` then refuses anything but a regular file with one link (a hard link would append
  // to its twin outside the folder).
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o644,
  )
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile() || stats.nlink > 1) throw new Error(`refusing to append to ${path}`)
    writeSync(fd, `${JSON.stringify(event)}\n`)
  } finally {
    closeSync(fd)
  }
}

/**
 * Keeps the learned root out of git (AH-A04): appends `/<root>/` to `<project>/.git/info/exclude`
 * once, and returns whether it did.
 *
 * The root sits inside the project, so a `git add .` would commit what the harness learned and share
 * it with everyone who clones. `info/exclude` is the repository's own ignore list, never the user's
 * `.gitignore`. Only a real `.git` directory counts — a symlinked `.git` or `.git/info`, or a `.git`
 * file (a worktree or submodule, whose exclude lives elsewhere) is left alone — and the file is opened
 * like the ledger, without following links and refusing anything but a regular file with one link.
 * A failure never fails the write: an unexcluded root is a hygiene gap, not a reason to lose a skill.
 */
export function excludeFromGit(projectID: string, root: string): boolean {
  const git = join(projectID, ".git")
  if (!lstatOrUndefined(git)?.isDirectory()) return false
  const info = join(git, "info")
  const infoStats = lstatOrUndefined(info)
  if (infoStats && !infoStats.isDirectory()) return false
  const line = `/${relative(projectID, root).split(sep).join("/")}/`
  try {
    if (!infoStats) mkdirSync(info)
    const fd = openSync(
      join(info, "exclude"),
      constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o644,
    )
    try {
      const stats = fstatSync(fd)
      if (!stats.isFile() || stats.nlink > 1) return false
      const text = readFileSync(fd, "utf8")
      if (text.split("\n").some((entry) => entry.trim() === line)) return false
      writeSync(fd, `${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`)
      return true
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown
  } catch {
    return undefined
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const SKILL_STATES: SkillState[] = ["probation", "mature", "stale", "archived", "merged"]

/** A sidecar read defensively: a corrupt or partial file reads as `undefined`, never as a crash. */
function parseSidecar(value: unknown): SkillSidecar | undefined {
  if (!isPlainObject(value)) return undefined
  if (typeof value.name !== "string" || typeof value.version !== "number" || typeof value.contentHash !== "string")
    return undefined
  const state = SKILL_STATES.find((candidate) => candidate === value.state)
  if (!state) return undefined
  if (!isPlainObject(value.source) || typeof value.source.projectID !== "string") return undefined
  const usage = isPlainObject(value.usage) ? value.usage : {}
  // Before AH-F02 `load`/`opportunities` counted suggestions and a `since` window drove the states;
  // both are dropped on read, so an old skill starts its real-use count from zero and is never
  // suggested for archiving before it has had `archiveAfter` real sessions.
  const engine = value.usageSource === "engine"
  const count = (source: Record<string, unknown>, key: string) => (typeof source[key] === "number" ? source[key] : 0)
  return {
    name: value.name,
    version: value.version,
    contentHash: value.contentHash,
    state,
    createdBy: typeof value.createdBy === "string" ? value.createdBy : "skillReflection",
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    source: {
      projectID: value.source.projectID,
      ...(typeof value.source.episodeID === "string" ? { episodeID: value.source.episodeID } : {}),
      ...(typeof value.source.proposalID === "string" ? { proposalID: value.source.proposalID } : {}),
      ...(typeof value.source.decisionID === "string" ? { decisionID: value.source.decisionID } : {}),
    },
    evidenceRefs: Array.isArray(value.evidenceRefs)
      ? value.evidenceRefs.filter((entry): entry is string => typeof entry === "string")
      : [],
    ...(typeof value.modelVersion === "string" ? { modelVersion: value.modelVersion } : {}),
    usage: {
      load: engine ? count(usage, "load") : 0,
      view: count(usage, "view"),
      patch: count(usage, "patch"),
      opportunities: engine ? count(usage, "opportunities") : 0,
    },
    ...(engine && typeof value.lastUsedAt === "number" ? { lastUsedAt: value.lastUsedAt } : {}),
    sessionsSinceUse: engine ? count(value, "sessionsSinceUse") : 0,
    ...(engine && Array.isArray(value.countedSessions)
      ? {
          countedSessions: value.countedSessions
            .filter(
              (entry): entry is CountedSession =>
                isPlainObject(entry) && typeof entry.id === "string" && typeof entry.used === "boolean",
            )
            .map((entry) => ({ id: entry.id, used: entry.used }))
            .slice(-COUNTED_SESSIONS_KEEP),
        }
      : {}),
    usageSource: "engine",
    ...(typeof value.provenance === "string" ? { provenance: value.provenance } : {}),
  }
}

export function createLearnedStore(
  deps: {
    env?: NodeJS.ProcessEnv
    snapshotKeep?: number
    now?: () => number
    /** The learning switch as a rule in the writer; absent means the store is not gated here. */
    enabled?: () => boolean
    /**
     * The install's key the provenance HMAC is taken under. It must be stable across restarts, or
     * every learned skill becomes read-only; absent, a process-local key is used (tests, tools).
     */
    key?: () => Buffer
  } = {},
): LearnedStore {
  const env = deps.env ?? process.env
  const snapshotKeep = deps.snapshotKeep ?? SNAPSHOT_KEEP
  const now = deps.now ?? Date.now

  const rootsFor = (projectID: string) => learnedRoots(projectID, env)

  // Resolved once: the key does not change within a process, and a read runs for every roster entry.
  let resolvedKey: Buffer | undefined
  const signingKey = () => (resolvedKey ??= deps.key?.() ?? EPHEMERAL_KEY)

  /**
   * The kill switch, fail-closed at the writer: with learning off the store refuses on its own rather
   * than trusting every caller to have gated. A caller that does not supply the switch is not gated
   * here (the curator and the manager still are).
   */
  const disabled = (): boolean => deps.enabled?.() === false

  /**
   * The guards every write shares, in the order ADR-0019 §2 fixes. Returns the resolved paths when
   * the write may proceed, or the reason it may not. The root is checked before `mkdir`, so a
   * symlinked ancestor is refused without creating anything outside the project.
   */
  const prepare = (
    projectID: string,
    name: string,
  ):
    | { ok: true; roots: LearnedRoots; skillDir: string; skillPath: string }
    | { ok: false; reason: LearnedWriteRejection } => {
    if (!NAME.test(name)) return { ok: false, reason: "invalid-name" }
    if (!usableProject(projectID)) return { ok: false, reason: "no-project" }
    const roots = rootsFor(projectID)
    // The guard runs before `mkdir`, so a symlinked ancestor is refused without creating anything.
    const rejectedRoot = rootRejection(projectID, roots.learned)
    if (rejectedRoot) return { ok: false, reason: rejectedRoot }
    const skillDir = join(roots.learned, name)
    // The root usually exists already; making a directory on every guard is a needless syscall.
    if (!existsSync(roots.learned)) {
      try {
        mkdirSync(roots.learned, { recursive: true })
      } catch {
        return { ok: false, reason: "write-failed" }
      }
    }
    if (!resolvesInside(skillDir, roots.learned)) return { ok: false, reason: "path-escape" }
    const rejectedFolder = folderRejection(skillDir)
    if (rejectedFolder) return { ok: false, reason: rejectedFolder }
    return { ok: true, roots, skillDir, skillPath: join(skillDir, SKILL_FILE) }
  }

  /**
   * The read counterpart of `prepare`: a valid name that resolves inside the learned root, without
   * creating anything. The same NAME and realpath containment guard a reader against `../` and
   * symlinks, so `readSidecar`/`read` can never be pointed at a human skill's tree.
   */
  const resolveRead = (projectID: string, name: string, where: "learned" | "disabled" = "learned"): string | undefined => {
    if (!NAME.test(name)) return undefined
    const root = rootsFor(projectID)[where]
    if (rootRejection(projectID, root)) return undefined
    const skillDir = join(root, name)
    if (!resolvesInside(skillDir, root)) return undefined
    if (folderRejection(skillDir)) return undefined
    return skillDir
  }

  /** A name another skill already uses outside the learned root is the engine's "last wins" hazard. */
  const collides = (projectID: string, name: string, learned: string): boolean => {
    const realLearned = safeRealpath(learned)
    return skillReport(projectID, projectID).some(
      (file) => file.loaded && file.name === name && !inside(safeRealpath(dirname(file.path)), realLearned),
    )
  }

  const pruneSnapshots = (versionsDir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(versionsDir)
    } catch {
      return
    }
    const ordered = entries.flatMap((entry): Array<{ path: string; at: number }> => {
      const path = join(versionsDir, entry)
      try {
        return [{ path, at: statSync(path).mtimeMs }]
      } catch {
        return []
      }
    })
    ordered
      .sort((left, right) => right.at - left.at || right.path.localeCompare(left.path))
      .slice(Math.max(snapshotKeep, 0))
      .forEach((entry) => {
        try {
          rmSync(entry.path, { force: true })
        } catch {
          // A snapshot that cannot be removed is not a reason to fail the write.
        }
      })
  }

  const write = (input: LearnedWriteInput): LearnedWriteResult => {
    if (disabled()) return { ok: false, reason: "disabled" }
    const prepared = prepare(input.projectID, input.name)
    if (!prepared.ok) return prepared
    const { roots, skillDir, skillPath } = prepared
    const at = input.at ?? now()

    let existing: string | undefined
    try {
      existing = readFileSync(skillPath, "utf8")
    } catch {
      existing = undefined
    }
    // A file without the marker is somebody's own skill: it is never overwritten, moved or deleted.
    if (existing !== undefined && !isSelfAuthored(existing)) return { ok: false, reason: "not-self-authored" }
    if (collides(input.projectID, input.name, roots.learned)) return { ok: false, reason: "name-collision" }

    const previous = existing === undefined ? undefined : readSidecarAt(skillDir, input.name)
    // A committed file can carry the marker; only a verified sidecar says the harness wrote it.
    if (existing !== undefined && !previous) return { ok: false, reason: "unverified" }
    const version = existing === undefined ? 1 : (previous?.version ?? 1) + 1
    const content = serialiseLearnedSkill({ name: input.name, description: input.description, body: input.body })
    const contentHash = contentHashOf(content)
    // A patch keeps the counters but starts a fresh unused count: the new version gets its own chance.
    const usage = previous?.usage ?? ZERO_USAGE
    const sidecar: SkillSidecar = {
      name: input.name,
      version,
      contentHash,
      state: "probation",
      createdBy: "skillReflection",
      createdAt: existing !== undefined ? (previous?.createdAt ?? at) : at,
      updatedAt: at,
      source: { projectID: input.projectID, ...input.source },
      evidenceRefs: input.evidenceRefs ?? [],
      ...(input.modelVersion ? { modelVersion: input.modelVersion } : {}),
      usage,
      ...(previous?.lastUsedAt !== undefined ? { lastUsedAt: previous.lastUsedAt } : {}),
      sessionsSinceUse: 0,
      // A patch keeps the counters, so it keeps the memory of which sessions they already include.
      ...(previous?.countedSessions ? { countedSessions: previous.countedSessions } : {}),
      usageSource: "engine",
      provenance: provenanceOf(signingKey(), input.name, contentHash).toString("hex"),
    }
    const event: LedgerEvent =
      existing === undefined
        ? { at, event: "created", version, contentHash, reason: input.reason ?? "reflection" }
        : { at, event: "patched", version, from: contentHashOf(existing), to: contentHash }

    // Before the skill is visible, so a `git add` in between cannot pick it up (AH-A04).
    excludeFromGit(input.projectID, roots.learned)
    const createdDirectory = !existsSync(skillDir)
    try {
      mkdirSync(skillDir, { recursive: true })
      // A patch snapshots the body it is about to replace, before the new one is visible.
      if (existing !== undefined) {
        mkdirSync(join(skillDir, VERSIONS_DIR), { recursive: true })
        atomicWrite(join(skillDir, VERSIONS_DIR, `${contentHashOf(existing)}.txt`), existing)
        pruneSnapshots(join(skillDir, VERSIONS_DIR))
      }
      if (existing === undefined) {
        // Create: sidecar and ledger first, so a crash before the rename leaves a folder with no
        // visible `SKILL.md` — invisible to both scanners.
        atomicWrite(join(skillDir, SIDECAR_FILE), `${JSON.stringify(sidecar, null, 2)}\n`)
        appendLedger(join(skillDir, LEDGER_FILE), event)
        atomicWrite(skillPath, content)
      } else {
        // Patch: the body first, then the ledger and the sidecar. The window then leaves a new body
        // with a lagging sidecar, never a sidecar that claims a body that is not there; reads verify
        // the hash so a lagging sidecar is not trusted either (`readSidecarAt`).
        atomicWrite(skillPath, content)
        appendLedger(join(skillDir, LEDGER_FILE), event)
        atomicWrite(join(skillDir, SIDECAR_FILE), `${JSON.stringify(sidecar, null, 2)}\n`)
      }
    } catch {
      // The folder was created by this attempt and has no visible skill: take it back.
      if (createdDirectory && !existsSync(skillPath)) {
        try {
          rmSync(skillDir, { recursive: true, force: true })
        } catch {
          // Leaving an invisible folder is not worth failing over.
        }
      }
      return { ok: false, reason: "write-failed" }
    }
    return { ok: true, path: skillPath, version, contentHash, state: "probation" }
  }

  /**
   * Moves a verified learned skill folder from one root to another: a rename, never a copy and a
   * delete. The same guards as a write apply to both ends (a real directory inside the project, no
   * planted link in the folder, the marker and a sidecar whose provenance verifies), so a skill a
   * repository committed is never moved, and the target is never overwritten.
   */
  const move = (input: {
    projectID: string
    name: string
    from: keyof LearnedRoots
    to: keyof LearnedRoots
    event: LedgerEvent
    /** The sidecar state written after the move; absent keeps the lifecycle state it had. */
    state?: SkillState
    /** The reason a target that already exists is refused with. */
    conflict: LearnedWriteRejection
  }): LearnedArchiveResult => {
    if (!NAME.test(input.name)) return { ok: false, reason: "invalid-name" }
    if (!usableProject(input.projectID)) return { ok: false, reason: "no-project" }
    const roots = rootsFor(input.projectID)
    const rejectedSource = rootRejection(input.projectID, roots[input.from])
    if (rejectedSource) return { ok: false, reason: rejectedSource }
    const source = join(roots[input.from], input.name)
    if (!existsSync(source)) return { ok: false, reason: "not-found" }
    if (!resolvesInside(source, roots[input.from])) return { ok: false, reason: "path-escape" }
    const rejectedFolder = folderRejection(source)
    if (rejectedFolder) return { ok: false, reason: rejectedFolder }
    let text: string
    try {
      text = readFileSync(join(source, SKILL_FILE), "utf8")
    } catch {
      // A folder without a visible `SKILL.md` is a half-written skill, not a self-authored one.
      return { ok: false, reason: "not-found" }
    }
    if (!isSelfAuthored(text)) return { ok: false, reason: "not-self-authored" }
    const sidecar = readSidecarAt(source, input.name)
    if (!sidecar) return { ok: false, reason: "unverified" }
    const rejectedTarget = rootRejection(input.projectID, roots[input.to])
    if (rejectedTarget) return { ok: false, reason: rejectedTarget }
    try {
      mkdirSync(roots[input.to], { recursive: true })
    } catch {
      return { ok: false, reason: "write-failed" }
    }
    const target = join(roots[input.to], input.name)
    if (!resolvesInside(target, roots[input.to])) return { ok: false, reason: "path-escape" }
    if (existsSync(target)) return { ok: false, reason: input.conflict }
    // What the harness learned stays off git wherever it sits, like the learned root (AH-A04).
    if (input.to === "disabled") excludeFromGit(input.projectID, roots.disabled)
    try {
      // A move on the same filesystem: `archive-not-delete`, and reviving is moving it back.
      renameSync(source, target)
      if (input.state)
        atomicWrite(
          join(target, SIDECAR_FILE),
          `${JSON.stringify({ ...sidecar, state: input.state, updatedAt: input.event.at }, null, 2)}\n`,
        )
      appendLedger(join(target, LEDGER_FILE), input.event)
    } catch {
      return { ok: false, reason: "write-failed" }
    }
    return { ok: true, path: target }
  }

  const archive = (input: {
    projectID: string
    name: string
    reason: string
    at?: number
    security?: boolean
  }): LearnedArchiveResult => {
    // A reverse-collision repair is a security move, not a learning write: it runs even with learning
    // off, so the human wins on disk too (ADR-0022 §4). Every other archive stays fail-closed.
    if (disabled() && input.security !== true) return { ok: false, reason: "disabled" }
    return move({
      projectID: input.projectID,
      name: input.name,
      from: "learned",
      to: "archive",
      event: { at: input.at ?? now(), event: "archived", reason: input.reason },
      state: "archived",
      conflict: "archive-exists",
    })
  }

  const disable = (input: { projectID: string; name: string; at?: number }): LearnedArchiveResult =>
    move({
      ...input,
      from: "learned",
      to: "disabled",
      event: { at: input.at ?? now(), event: "disabled", reason: HUMAN_REASON },
      conflict: "exists",
    })

  const enable = (input: { projectID: string; name: string; at?: number }): LearnedArchiveResult => {
    // Back under `skills/`, a name a human skill took in the meantime would be the "last wins" hazard.
    if (usableProject(input.projectID) && collides(input.projectID, input.name, rootsFor(input.projectID).learned))
      return { ok: false, reason: "name-collision" }
    return move({
      ...input,
      from: "disabled",
      to: "learned",
      event: { at: input.at ?? now(), event: "enabled", reason: HUMAN_REASON },
      conflict: "exists",
    })
  }

  const retire = (input: { projectID: string; name: string; at?: number }): LearnedArchiveResult =>
    move({
      ...input,
      from: existsSync(join(rootsFor(input.projectID).learned, input.name)) ? "learned" : "disabled",
      to: "archive",
      event: { at: input.at ?? now(), event: "archived", reason: HUMAN_REASON },
      state: "archived",
      conflict: "archive-exists",
    })

  const listDisabled = (projectID: string): Array<{ name: string; description: string; sidecar: SkillSidecar }> => {
    if (!usableProject(projectID)) return []
    const root = rootsFor(projectID).disabled
    if (rootRejection(projectID, root) || !existsSync(root)) return []
    const names = (() => {
      try {
        return readdirSync(root).filter((entry) => NAME.test(entry)).sort()
      } catch {
        return []
      }
    })()
    return names.flatMap((name) => {
      const skill = read(projectID, name, "disabled")
      const sidecar = skill ? readSidecarAt(join(root, name), name) : undefined
      return skill && sidecar ? [{ name, description: skill.description, sidecar }] : []
    })
  }

  const updateSidecar = (input: LearnedSidecarUpdate): LearnedSidecarResult => {
    if (disabled()) return { ok: false, reason: "disabled" }
    const prepared = prepare(input.projectID, input.name)
    if (!prepared.ok) return prepared
    const { skillDir, skillPath } = prepared
    if (!existsSync(skillPath)) return { ok: false, reason: "not-found" }
    if (!isSelfAuthored(readFileSync(skillPath, "utf8"))) return { ok: false, reason: "not-self-authored" }
    const at = input.at ?? now()
    // A missing, corrupt or lagging sidecar is not rebuilt: signing the body on disk would adopt
    // whatever a repository committed there, so an unverified skill stays read-only.
    const current = readSidecarAt(skillDir, input.name)
    if (!current) return { ok: false, reason: "unverified" }
    const next: SkillSidecar = {
      ...current,
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      ...(input.lastUsedAt !== undefined ? { lastUsedAt: input.lastUsedAt } : {}),
      ...(input.sessionsSinceUse !== undefined ? { sessionsSinceUse: input.sessionsSinceUse } : {}),
      ...(input.countedSessions !== undefined
        ? { countedSessions: input.countedSessions.slice(-COUNTED_SESSIONS_KEEP) }
        : {}),
      updatedAt: at,
    }
    try {
      atomicWrite(join(skillDir, SIDECAR_FILE), `${JSON.stringify(next, null, 2)}\n`)
      for (const event of input.events ?? []) appendLedger(join(skillDir, LEDGER_FILE), event)
    } catch {
      return { ok: false, reason: "write-failed" }
    }
    return { ok: true, sidecar: next }
  }

  /**
   * The sidecar beside a skill, trusted only when it still describes the body on disk and its
   * provenance verifies for this folder's name under the install's key.
   *
   * A crash between the body and the sidecar (or between the sidecar and the body) can leave a
   * `contentHash` for a version that is no longer there. A read must not report that provenance, so a
   * sidecar whose hash does not match the body reads as missing — the same as a corrupt or unsigned
   * one, which is what a repository-committed skill is.
   */
  const readSidecarAt = (skillDir: string, name: string): SkillSidecar | undefined => {
    const sidecar = parseSidecar(readJson(join(skillDir, SIDECAR_FILE)))
    if (!sidecar?.provenance) return undefined
    let text: string
    try {
      text = readFileSync(join(skillDir, SKILL_FILE), "utf8")
    } catch {
      return undefined
    }
    if (contentHashOf(text) !== sidecar.contentHash) return undefined
    const expected = provenanceOf(signingKey(), name, sidecar.contentHash)
    const given = Buffer.from(sidecar.provenance, "hex")
    return given.length === expected.length && timingSafeEqual(given, expected) ? sidecar : undefined
  }

  const read = (
    projectID: string,
    name: string,
    where: "learned" | "disabled" = "learned",
  ): { name: string; description: string; body: string } | undefined => {
    const skillDir = resolveRead(projectID, name, where)
    if (!skillDir) return undefined
    let text: string
    try {
      text = readFileSync(join(skillDir, SKILL_FILE), "utf8")
    } catch {
      return undefined
    }
    if (!isSelfAuthored(text) || !readSidecarAt(skillDir, name)) return undefined
    const { fields, prompt } = parseFrontmatter(text)
    return {
      name,
      description: typeof fields.description === "string" ? fields.description : "",
      body: prompt,
    }
  }

  return {
    roots: rootsFor,
    write,
    archive,
    disable,
    enable,
    retire,
    listDisabled,
    updateSidecar,
    readSidecar: (projectID, name) => {
      const skillDir = resolveRead(projectID, name)
      return skillDir ? readSidecarAt(skillDir, name) : undefined
    },
    read,
  }
}
