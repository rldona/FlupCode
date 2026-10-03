import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { readSteps } from "./actions"
import { BrowserError } from "./browser-driver"
import { isLoopbackUrl, type Preview } from "./browser-preview"
import { originOf, stepTier, type BrowserPolicy, type DecideInput } from "./browser-policy"
import { decodePng, encodePng, type Image } from "./png"
import type { SqliteRoutineRepository } from "./repository"
import type { TaskVerdict, VisualCheck, VisualResult, VisualShot, VisualStep } from "./types"
import { compareImages, type Region } from "./visual-compare"
import { previewTarget } from "./verify"

/**
 * A verify task that looks at the page (CL-4, audit §13).
 *
 * The workflow declares it on a `verify` task:
 *
 * ```yaml
 * - id: look
 *   kind: verify
 *   visual:
 *     url: http://localhost:5173/          # absent: `preview` in .flupcode/project.yaml
 *     steps:                               # the web recipe's grammar
 *       - waitFor: "#app"
 *       - screenshot: home
 *       - click: "a[href='/settings']"
 *       - screenshot: settings
 *     mask: [".clock"]                     # not compared
 *     tolerance: 0.5%                      # of the compared pixels
 *     settle: { captures: 4, interval: 250ms }
 * ```
 *
 * It runs in the desktop app's preview (BU-06), the one browser here that may open the project's dev
 * server: FlupCode's own browser refuses this machine and its network (WA-1), and the person's own
 * browser (BU-04) is theirs. So outside the desktop app the check does not run, and says so; it is
 * then not a check that ran, and cannot make the task `verified` (P4).
 *
 * Every step is the browser policy's decision before the driver acts and is recorded after (P7),
 * like any other driver's: the workflow file is the project's consent for its own script on its own
 * page on this machine, in a routine rule's grammar, and a page off this machine is never opened.
 *
 * Each `screenshot` is kept as the next version of one screenshot artifact per project, workflow,
 * task and name (RP-03), so "before" is the version before it, and their difference is kept beside it.
 */

/**
 * A `visual:` block as a workflow writes it, read into what a task carries, or why it cannot be.
 * `true` (or an empty block) looks at the project's page as it is, with one capture.
 */
export function readVisualCheck(raw: unknown): { ok: true; check: VisualCheck } | { ok: false; problem: string } {
  if (raw === true) return { ok: true, check: { steps: [], mask: [], tolerance: DEFAULT_TOLERANCE, settle: DEFAULT_SETTLE } }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problem: "visual must be a mapping" }
  const value = raw as Record<string, unknown>
  const url = value.url
  if (url !== undefined && (typeof url !== "string" || !isLoopbackUrl(url)))
    return { ok: false, problem: "visual.url must be a page on this machine (localhost or 127.0.0.1)" }
  const steps = value.steps === undefined ? { ok: true as const, steps: [] } : readSteps(value.steps, {}, undefined)
  if (!steps.ok) return { ok: false, problem: `visual.steps: ${steps.message}` }
  const refused = steps.steps.findIndex(
    (step) => "submit" in step || "upload" in step || ("fill" in step && step.fill.credential !== undefined),
  )
  if (refused >= 0)
    return { ok: false, problem: `visual.steps: Step ${refused + 1}: a visual check only looks, clicks and types text: no submit, upload or credential` }
  const away = steps.steps.find((step) => "goto" in step && URL.canParse(step.goto) && !isLoopbackUrl(step.goto))
  if (away) return { ok: false, problem: "visual.steps: a goto can only open a page on this machine" }
  const mask = value.mask === undefined ? [] : value.mask
  if (!Array.isArray(mask) || mask.some((entry) => typeof entry !== "string" || !entry.trim()))
    return { ok: false, problem: "visual.mask must be a list of selectors" }
  const tolerance = readTolerance(value.tolerance)
  if (tolerance === undefined) return { ok: false, problem: "visual.tolerance must be a share below 100%, like 0.5% or 0.005" }
  const settle = readSettle(value.settle)
  if (!settle) return { ok: false, problem: "visual.settle needs captures between 2 and 10 and an interval up to 5s" }
  return {
    ok: true,
    check: {
      ...(typeof url === "string" ? { url } : {}),
      steps: steps.steps as VisualStep[],
      mask: mask.map((entry: string) => entry.trim()),
      tolerance,
      settle,
    },
  }
}

/** The task a visual check runs for, and where its evidence goes. */
export type VisualTask = {
  check: VisualCheck
  directory: string
  runID: string
  taskID: string
  name: string
  /** The workflow the run executed, part of what makes two captures "the same step". */
  workflow?: string
  stopped: () => boolean
}

export type VisualRunner = (task: VisualTask) => Promise<VisualResult>

/** The desktop preview's visual check (CL-4). Only a server with a preview has one. */
export function createVisualCheck(input: {
  /** Its captures are written to the preview's data folder, beside its annotations. */
  preview: Pick<Preview, "connected" | "driver" | "regions" | "dataDir">
  policy: Pick<BrowserPolicy, "decide" | "spend" | "recordAction">
  repository: Pick<SqliteRoutineRepository, "addArtifact" | "newestVersion">
}): VisualRunner {
  return async (task) => {
    const url = task.check.url ?? (await previewTarget(task.directory))
    if (!url)
      return notRun(undefined, "no page to look at: name one under `visual.url` or `preview` in .flupcode/project.yaml")
    if (!isLoopbackUrl(url)) return notRun(url, "it is not a page on this machine")
    if (!input.preview.connected()) return notRun(url, PREVIEW_ONLY)
    const id = `visual:${task.taskID}`
    const driver = input.preview.driver
    // The page opens first; a script that starts with its own `goto` still starts from here.
    const steps: VisualStep[] = [{ goto: url }, ...task.check.steps]
    const script = task.check.steps.some((step) => "screenshot" in step) ? steps : [...steps, { screenshot: task.name }]
    const shots: VisualShot[] = []
    await driver.open({ id, project: task.directory, runID: task.runID, taskID: task.taskID })
    try {
      for (const [index, step] of script.entries()) {
        if (task.stopped()) return { status: "not-run", url, problem: "the run was stopped", shots }
        const target = "goto" in step ? new URL(step.goto, url).href : url
        if ("goto" in step && !isLoopbackUrl(target))
          return { status: "failed", url, problem: `Step ${index}: ${target} is not a page on this machine`, shots }
        const question: DecideInput = {
          origin: "goto" in step ? target : (driver.get(id)?.url ?? url),
          tier: stepTier(step),
          runId: task.runID,
          taskId: task.taskID,
          action: `visual.${task.name}`,
          rules: consent(originOf(url)!, task.name),
        }
        const decision = input.policy.decide(question)
        if (decision.decision !== "allow" || !input.policy.spend(decision.permit, question))
          return { status: "not-run", url, problem: `the browser policy did not allow ${describe(step)}: ${decision.reason}`, shots }
        const outcome = await act(step, target).then(
          (shot) => ({ ok: true as const, shot }),
          (cause: unknown) => ({ ok: false as const, detail: cause instanceof Error ? cause.message : String(cause) }),
        )
        input.policy.recordAction(question, {
          outcome: outcome.ok ? "success" : "failed",
          ...(outcome.ok && outcome.shot ? { artifactID: outcome.shot.after } : {}),
          ...(outcome.ok ? {} : { detail: outcome.detail }),
        })
        if (!outcome.ok) {
          // The preview went away mid-script: nothing the page did, so the check did not run.
          if (!input.preview.connected()) return { status: "not-run", url, problem: PREVIEW_ONLY, shots }
          return { status: "failed", url, problem: `Step ${index} (${describe(step)}): ${outcome.detail}`, shots }
        }
        if (outcome.shot) shots.push(outcome.shot)
      }
      return { status: "ran", url, shots }
    } finally {
      await driver.close(id)
    }

    async function act(step: VisualStep, target: string): Promise<VisualShot | undefined> {
      const timeout = "timeoutMs" in step && step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}
      if ("goto" in step) return void (await driver.act(id, { kind: "navigate", url: target }))
      if ("waitFor" in step)
        return void (await driver.act(id, { kind: "waitFor", selector: step.waitFor, ...timeout, ...(step.state ? { state: step.state } : {}) }))
      if ("click" in step) return void (await driver.act(id, { kind: "click", selector: step.click, ...timeout }))
      if ("fill" in step)
        return void (await driver.act(id, { kind: "type", selector: step.fill.selector, text: step.fill.text ?? "", ...timeout }))
      if ("assert" in step) {
        const found = await driver.act(id, { kind: "read", selector: step.assert.selector, ...timeout })
        const expected = step.assert.text?.replace(/\s+/g, " ").trim()
        if (expected !== undefined && found.value !== expected)
          throw new Error(`Expected "${expected}" but found "${found.value ?? ""}"`)
        return undefined
      }
      if ("screenshot" in step) return capture(step.screenshot)
      throw new BrowserError("action_failed", 422, "A visual check does not run that step")
    }

    /** A capture once the page holds still, compared with the step's last one and kept as its next version. */
    async function capture(shot: string): Promise<VisualShot> {
      const settled = await settle()
      const key = createHash("sha256")
        .update([task.directory, task.workflow ?? "", task.name, shot].join("\0"))
        .digest("hex")
        .slice(0, 32)
      const previous = input.repository.newestVersion(`visual:${key}`)
      const before = previous?.path && previous.directory ? readImage(join(previous.directory, previous.path)) : undefined
      const title = `${task.name} — ${shot}`
      const after = keep(settled.bytes, { title, logicalID: `visual:${key}` })
      if (!previous || !before) return { name: shot, outcome: "first", changed: 0, stable: settled.stable, after: after.id }
      const comparison = compareImages(before, settled.image, { masks: settled.masks })
      const diff = keep(encodePng(comparison.diff), { title: `${title} — difference`, logicalID: `visual-difference:${key}` })
      return {
        name: shot,
        outcome: comparison.changed > task.check.tolerance ? "changed" : "same",
        changed: comparison.changed,
        stable: settled.stable,
        after: after.id,
        before: previous.id,
        diff: diff.id,
      }
    }

    /**
     * Captures until two in a row agree within the tolerance, the masked regions aside: an animation,
     * a font still loading or a late image would otherwise be a change that is not one. The last
     * capture is kept either way, and whether the page held still is said.
     */
    async function settle() {
      const captures: Array<{ bytes: Uint8Array; image: Image; masks: Region[] }> = []
      for (const attempt of Array.from({ length: task.check.settle.captures }, (_, index) => index)) {
        if (attempt > 0) await Bun.sleep(task.check.settle.intervalMs)
        const bytes = (await driver.screenshot(id, { store: false })).bytes
        const image = decodePng(bytes)
        const masks = await masksFor(image)
        const last = captures.at(-1)
        captures.push({ bytes, image, masks })
        if (last && compareImages(last.image, image, { masks: [...last.masks, ...masks] }).changed <= task.check.tolerance)
          return { ...captures.at(-1)!, stable: true }
      }
      return { ...captures.at(-1)!, stable: false }
    }

    /** Where the masked elements are, in the capture's own pixels (a retina capture is twice the page). */
    async function masksFor(image: Image): Promise<Region[]> {
      if (task.check.mask.length === 0) return []
      const found = await input.preview.regions(task.check.mask)
      const scale = found.width > 0 ? image.width / found.width : 1
      return found.boxes.map((box) => ({ x: box.x * scale, y: box.y * scale, width: box.width * scale, height: box.height * scale }))
    }

    function keep(bytes: Uint8Array, meta: { title: string; logicalID: string }) {
      const relative = join("visual", `${randomUUID()}.png`)
      mkdirSync(dirname(join(input.preview.dataDir, relative)), { recursive: true })
      writeFileSync(join(input.preview.dataDir, relative), bytes)
      return input.repository.addArtifact({
        kind: "screenshot",
        title: meta.title,
        mime: "image/png",
        producer: "harness",
        path: relative,
        directory: input.preview.dataDir,
        hash: createHash("sha256").update(bytes).digest("hex"),
        logicalID: meta.logicalID,
        runID: task.runID,
        taskID: task.taskID,
      })
    }
  }
}

/**
 * What a visual check says about the task (RP-06), worst first: a step that failed fails it; a page
 * that changed beyond the tolerance needs a person to look at the before and after; a check that did
 * not run, a page that never held still, or a first capture with nothing to compare with leave it
 * `unverified`; only captures that match the step's last ones are a check that ran and passed.
 */
export function visualVerdict(result: VisualResult): TaskVerdict {
  if (result.status === "failed") return { value: "failed", reason: `The visual check failed: ${result.problem}`, source: "check" }
  if (result.status === "not-run")
    return { value: "unverified", reason: `The visual check did not run: ${result.problem}`, source: "check" }
  const changed = result.shots.filter((shot) => shot.outcome === "changed")
  if (changed.length > 0)
    return {
      value: "needs-user",
      reason: `The page changed: ${changed.map((shot) => `${shot.name} (${percent(shot.changed)} of it)`).join(", ")}. Compare before and after.`,
      source: "check",
    }
  const unsteady = result.shots.filter((shot) => !shot.stable)
  if (unsteady.length > 0)
    return {
      value: "unverified",
      reason: `The page did not hold still for ${unsteady.map((shot) => shot.name).join(", ")}: mask what moves, or give it longer to settle.`,
      source: "check",
    }
  const first = result.shots.filter((shot) => shot.outcome === "first")
  if (first.length > 0)
    return {
      value: "unverified",
      reason: `Nothing to compare ${first.map((shot) => shot.name).join(", ")} with yet: this capture is the first, and the next run compares with it.`,
      source: "check",
    }
  return { value: "verified", reason: `The page looks as it did: ${result.shots.length} ${result.shots.length === 1 ? "capture matches" : "captures match"} the last ones.`, source: "check" }
}

/** The visual check, in the task's evidence after the commands' report. */
export function visualEvidence(result: VisualResult) {
  const page = result.url ? ` of ${result.url}` : ""
  if (result.status === "not-run") return `Visual check${page}: did not run: ${result.problem}.`
  const lines = result.shots.map((shot) => {
    const held = shot.stable ? "" : " (it did not hold still)"
    if (shot.outcome === "first") return `- ${shot.name} — first capture, nothing to compare with yet${held} (artifact ${shot.after})`
    return `- ${shot.name} — ${shot.outcome === "same" ? "same as before" : "changed"}: ${percent(shot.changed)} of the page differs${held} (artifact ${shot.after}, before ${shot.before}, difference ${shot.diff})`
  })
  return [`Visual check${page}: ${result.status === "failed" ? `failed: ${result.problem}` : "ran"}`, ...lines].join("\n")
}

/** What a task without a preview says (CL-4): the check only runs in the desktop app. */
export const PREVIEW_ONLY = "the desktop app's preview is not open, and a visual check only runs there"

const DEFAULT_TOLERANCE = 0.001
const DEFAULT_SETTLE = { captures: 4, intervalMs: 250 }

const notRun = (url: string | undefined, problem: string): VisualResult => ({
  status: "not-run",
  ...(url ? { url } : {}),
  problem,
  shots: [],
})

const percent = (share: number) => `${(share * 100).toFixed(share > 0 && share < 0.001 ? 3 : 2)}%`

/**
 * The project's own consent for its own script, in a routine rule's grammar: opening and reading its
 * page, and this check's steps on it, nothing else. The page is on this machine, which is checked
 * before this is ever asked.
 */
const consent = (origin: string, name: string) => [
  { permission: "browser" as const, pattern: origin, action: "allow" as const },
  { permission: "browser_sensitive" as const, pattern: `${origin}:visual.${name}`, action: "allow" as const },
]

const describe = (step: VisualStep) => {
  if ("goto" in step) return `goto ${step.goto}`
  if ("waitFor" in step) return `waitFor ${step.waitFor}`
  if ("click" in step) return `click ${step.click}`
  if ("fill" in step) return `fill ${step.fill.selector}`
  if ("assert" in step) return `assert ${step.assert.selector}`
  return `screenshot ${step.screenshot}`
}

/** A kept capture, or nothing when its file is gone or is not a PNG this can read. */
function readImage(path: string) {
  try {
    return decodePng(readFileSync(path))
  } catch {
    return undefined
  }
}

function readTolerance(value: unknown) {
  if (value === undefined) return DEFAULT_TOLERANCE
  const share =
    typeof value === "number" ? value : typeof value === "string" && /^\d+(\.\d+)?\s*%$/.test(value.trim()) ? Number.parseFloat(value) / 100 : NaN
  return Number.isFinite(share) && share >= 0 && share < 1 ? share : undefined
}

function readSettle(value: unknown) {
  if (value === undefined) return DEFAULT_SETTLE
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const captures = record.captures ?? DEFAULT_SETTLE.captures
  // `250ms`, `1s`, or a number of milliseconds.
  const written = typeof record.interval === "string" ? /^(\d+(?:\.\d+)?)\s*(ms|s)$/.exec(record.interval.trim()) : undefined
  const intervalMs =
    record.interval === undefined
      ? DEFAULT_SETTLE.intervalMs
      : typeof record.interval === "number"
        ? record.interval
        : written
          ? Number(written[1]) * (written[2] === "s" ? 1000 : 1)
          : undefined
  if (typeof captures !== "number" || !Number.isInteger(captures) || captures < 2 || captures > 10) return undefined
  if (intervalMs === undefined || intervalMs < 0 || intervalMs > 5000) return undefined
  return { captures, intervalMs }
}
