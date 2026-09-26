/**
 * The deterministic runner for a web recipe (WA-2).
 *
 * A profile is validated before anything opens, its inputs are materialized, its guards must allow,
 * and only then does a browser start. The whole recipe runs in one call: there is no admission
 * between steps here, because approval happens once, before the request arrives (WA-3). A failure
 * keeps the evidence gathered up to and including the step that failed.
 */

import { BrowserError } from "./browser"
import type { BrowserRuntime } from "./browser"
import { NavigationBlockedError } from "./browser-egress"
import { ActionInputError, resolveActionInputs } from "./action-inputs"
import type { ResolvedActionInputs } from "./action-inputs"
import { collectCredentialNames } from "./action-credentials"
import type { ActionCredentialResolver } from "./action-credentials"
import { redactSecrets } from "./redact"
import { runActionGuards } from "./action-guards"
import { substituteActionTemplate, validateActionProfile } from "./actions"
import type { ActionInputKind, ActionProfile, ActionStep, ActionStepName } from "./actions"
import type { ActionProfilesSource, ActionProfileScope } from "./config-files"
import type { SqliteRoutineRepository } from "./repository"

export const MAX_STEP_ATTEMPTS = 2
export const RETRY_DELAY_MS = 250

const UPLOAD_FROM = /^\{\{\s*([A-Za-z0-9_-]+)\s*\}\}$/
const TEMPLATE_INPUT = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g

/** Step failures that can never turn out differently on a second attempt. */
const NON_RETRYABLE = new Set([
  "origin_mismatch",
  "unknown_input",
  "invalid_template",
  "image_in_text",
  "invalid_input",
  "credential_unavailable",
  "navigation_blocked",
  "stopped",
])

export type ActionRunRequest = {
  action?: string
  profile?: unknown
  inputs?: Record<string, unknown>
  sessionID: string
  project: string
  /**
   * The folder a project-scoped profile is resolved from (WA-8).
   *
   * `project` is the browser's own identity and stays the profile reservation key; `directory` is
   * the editor's folder, which is what decides whether a `.opencode` profile overrides a global one.
   */
  directory?: string
  headed?: boolean
  dryRun?: boolean
  /**
   * Drive the recipe for real, but stop before the first side effect (WA-8).
   *
   * The editor's preview: read-only steps run, the step that would change the page and everything
   * after it are reported as skipped, no credential is resolved and no evidence is filed.
   */
  preview?: boolean
  /**
   * The run and task this action belongs to (WA-7).
   *
   * An interactive call has a session the evidence can hang on; a scheduled one has none, so it
   * names the run and task and every artifact — screenshot or text — is filed under them.
   */
  runID?: string
  taskID?: string
  /** The run was stopped: refuse between steps instead of driving a browser nobody is watching. */
  stopped?: () => boolean
  /**
   * Close the browser when the run ends (WA-7).
   *
   * A scheduled action keys its browser by task id and has nobody to reuse it, so leaving it open
   * would hold the project's reservation until the idle timeout. The interactive path keeps it.
   */
  closeOnFinish?: boolean
}

export type ActionStepReport = {
  index: number
  kind: ActionStepName
  /** `skipped` is a preview step at or after the first side effect (WA-8). */
  status: "ok" | "failed" | "planned" | "skipped"
  attempts: number
  durationMs: number
  screenshot?: string
  /** Why a preview step failed, kept on the report so the editor can show it (WA-8). */
  error?: string
}

export type ActionRunResult = {
  action: string
  tool: string
  status: "success"
  origin: string
  url: string
  title: string
  startedAt: number
  finishedAt: number
  steps: ActionStepReport[]
  evidence: string[]
  extract?: Record<string, string>
}

export type ActionDryRunResult = {
  action: string
  tool: string
  status: "dry-run"
  origin: string
  steps: ActionStepReport[]
}

/**
 * What a preview run answers (WA-8).
 *
 * The steps that ran for real, the step the cut landed on and everything after it. No evidence, no
 * extract and no credential: a preview is what the recipe would do, not a run of it.
 */
export type ActionPreviewResult = {
  action: string
  tool: string
  status: "preview"
  origin: string
  url: string
  title: string
  startedAt: number
  finishedAt: number
  steps: ActionStepReport[]
}

/** A profile as the catalogue lists it, with the layer that declared it (WA-8). */
export type ActionCatalogProfile = ActionProfile & { scope: ActionProfileScope }

export type ActionListInput = { directory?: string; project?: string }

export type ActionRunner = {
  list(input?: ActionListInput): {
    profiles: ActionCatalogProfile[]
    rejected: Array<{ id: string; code: string; message: string }>
  }
  run(input: ActionRunRequest): Promise<ActionRunResult | ActionDryRunResult | ActionPreviewResult>
}

export type ActionRunnerOptions = {
  browser: BrowserRuntime
  repository: Pick<SqliteRoutineRepository, "addArtifact" | "getArtifact">
  credentials: ActionCredentialResolver
  loadProfiles: (input?: ActionListInput) => ActionProfilesSource
  defaultEvidence?: "each" | "failure" | "none"
}

export type ActionErrorInit = {
  code: string
  status: number
  message: string
  action?: string
  step?: ActionStepName
  index?: number
  field?: string
  guardCode?: string
  evidence?: string[]
  url?: string
}

export class ActionRunError extends Error {
  readonly code: string
  readonly status: number
  readonly action?: string
  readonly step?: ActionStepName
  readonly index?: number
  readonly field?: string
  readonly guardCode?: string
  readonly evidence: string[]
  readonly url?: string

  constructor(init: ActionErrorInit) {
    super(init.message)
    this.name = "ActionRunError"
    this.code = init.code
    this.status = init.status
    this.evidence = init.evidence ?? []
    if (init.action !== undefined) this.action = init.action
    if (init.step !== undefined) this.step = init.step
    if (init.index !== undefined) this.index = init.index
    if (init.field !== undefined) this.field = init.field
    if (init.guardCode !== undefined) this.guardCode = init.guardCode
    if (init.url !== undefined) this.url = init.url
  }
}

export const toActionErrorBody = (error: ActionRunError) => ({
  error: error.message,
  code: error.code,
  ...(error.action !== undefined ? { action: error.action } : {}),
  ...(error.step !== undefined ? { step: error.step } : {}),
  ...(error.index !== undefined ? { index: error.index } : {}),
  ...(error.field !== undefined ? { field: error.field } : {}),
  ...(error.guardCode !== undefined ? { guardCode: error.guardCode } : {}),
  evidence: error.evidence,
  ...(error.url !== undefined ? { url: error.url } : {}),
})

export function createActionRunner(options: ActionRunnerOptions): ActionRunner {
  const { browser, repository, credentials, loadProfiles } = options
  const fallbackEvidence = options.defaultEvidence ?? "each"

  const list = (input?: ActionListInput) => {
    const source = loadProfiles(input)
    const profiles: ActionCatalogProfile[] = []
    const rejected: Array<{ id: string; code: string; message: string }> = []
    const tools = new Set<string>()
    for (const [id, raw] of Object.entries(source.profiles)) {
      const result = validateActionProfile(id, raw)
      if (!result.ok) {
        rejected.push({ id, code: result.code, message: result.message })
        continue
      }
      if (tools.has(result.profile.tool)) {
        rejected.push({ id, code: "duplicate_tool", message: `Tool "${result.profile.tool}" is already defined` })
        continue
      }
      tools.add(result.profile.tool)
      profiles.push({ ...result.profile, scope: source.scopes[id] ?? "global" })
    }
    return { profiles, rejected }
  }

  const run = async (
    input: ActionRunRequest,
  ): Promise<ActionRunResult | ActionDryRunResult | ActionPreviewResult> => {
    const source = loadProfiles({ directory: input.directory, project: input.project })
    const profile = resolveProfile(source, input)
    const provided = isPlainObject(input.inputs) ? input.inputs : {}
    // A preview is read before the form is filled, so only what it was given is materialized: a
    // missing input is left for the step that would use it, past the cut, rather than refused here.
    const resolved = await resolveActionInputs({
      profile,
      provided,
      repository,
      ...(input.preview === true ? { partial: true } : {}),
    }).catch((cause) => {
      throw inputFailure(cause, profile)
    })
    const secrets: string[] = []
    try {
      const verdict = await runActionGuards({
        guards: profile.guards,
        configDir: source.guardDirs[profile.id] ?? source.configDir,
        input: { action: profile.id, tool: profile.tool, origin: profile.origin, inputs: resolved.values },
      })
      if (!verdict.allow)
        throw new ActionRunError({
          code: "guard_denied",
          status: 422,
          message: verdict.message,
          action: profile.id,
          guardCode: verdict.code,
        })

      if (input.dryRun === true)
        return {
          action: profile.id,
          tool: profile.tool,
          status: "dry-run",
          origin: profile.origin,
          steps: profile.steps.map((step, index) => plannedReport(step, index)),
        }

      if (input.preview === true) return await previewDrive(profile, resolved, input)

      return await drive(profile, resolved, input, secrets)
    } finally {
      resolved.cleanup()
      // A scheduled action is one shot: closing here releases the project before the task is
      // written down, and a failure closes just the same. Interactive calls keep their window.
      if (input.closeOnFinish === true) await browser.close(input.sessionID).catch(() => undefined)
    }
  }

  const drive = async (
    profile: ActionProfile,
    resolved: ResolvedActionInputs,
    input: ActionRunRequest,
    secrets: string[],
  ): Promise<ActionRunResult> => {
    const sessionID = input.sessionID
    const credentialValues: Record<string, string> = {}
    for (const name of collectCredentialNames(profile)) {
      const value = await credentials.resolve({ name, origin: profile.origin })
      if (value === undefined)
        throw new ActionRunError({
          code: "credential_unavailable",
          status: 422,
          message: `The credential "${name}" is not available`,
          action: profile.id,
        })
      secrets.push(value)
      credentialValues[name] = value
    }

    await browser.start({
      id: sessionID,
      project: input.project,
      ...(input.headed === true ? { headed: true } : {}),
      ...(input.runID ? { runID: input.runID } : {}),
      ...(input.taskID ? { taskID: input.taskID } : {}),
    })
    // Registered the moment the browser exists, not when a `fill` happens: a run that fails before
    // the credential is typed still must not echo it from a snapshot or a capture.
    for (const value of Object.values(credentialValues)) browser.protect(sessionID, { value })
    const mode = profile.evidence.screenshots ?? fallbackEvidence
    const context: StepContext = {
      sessionID,
      values: resolved.values,
      images: resolved.images,
      credentials: credentialValues,
    }
    const capture = async (index: number, kind: ActionStepName): Promise<string | undefined> => {
      try {
        const { artifactId } = await browser.screenshot(sessionID, `${profile.id}:${index}:${kind}`)
        return artifactId
      } catch {
        return undefined
      }
    }

    const evidence: string[] = []
    const steps: ActionStepReport[] = []
    const startedAt = Date.now()

    for (const [index, step] of profile.steps.entries()) {
      // A scheduled run can be stopped with nothing driving the browser: the flag is checked
      // between steps, so the recipe does not carry on opening windows nobody asked for (WA-7).
      if (input.stopped?.() === true) throw stoppedError(profile)
      const kind = stepKind(step)
      const stepStartedAt = Date.now()
      const allowed = canRetry(kind) ? MAX_STEP_ATTEMPTS : 1
      let attempt = 0
      let explicit: string | undefined
      let failure: unknown
      while (attempt < allowed) {
        attempt += 1
        try {
          // The stop/pause seam (WA-6): a person may hold or stop the run between steps, and the
          // check is inside the attempt so a retry does not slip past a pause.
          await browser.waitIfPaused(sessionID)
          explicit = await runStep(browser, profile, step, context)
          failure = undefined
          break
        } catch (cause) {
          failure = cause
          if (!canRetry(kind) || !isRetryable(cause) || attempt >= allowed) break
          await sleep(RETRY_DELAY_MS)
        }
      }

      const report: ActionStepReport = {
        index,
        kind,
        status: failure === undefined ? "ok" : "failed",
        attempts: attempt,
        durationMs: Date.now() - stepStartedAt,
      }
      if (explicit !== undefined) {
        evidence.push(explicit)
        report.screenshot = explicit
      }

      if (failure === undefined) {
        // A step that produced its own evidence (a `screenshot` action) must not also trigger the
        // automatic capture: that would store the same frame twice under the same step.
        if (mode === "each" && explicit === undefined) {
          const auto = await capture(index, kind)
          if (auto !== undefined) {
            evidence.push(auto)
            report.screenshot ??= auto
          }
        }
        steps.push(report)
        continue
      }

      if (mode === "each" || mode === "failure") {
        const auto = await capture(index, kind)
        if (auto !== undefined) {
          evidence.push(auto)
          report.screenshot ??= auto
        }
      }
      steps.push(report)
      throw stepFailure(profile, step, index, failure, evidence, secrets)
    }

    let extract: Record<string, string> | undefined
    if (profile.extract !== undefined) {
      extract = {}
      for (const [field, spec] of Object.entries(profile.extract)) {
        const found = await browser
          .text(sessionID, spec.selector, {
            ...(spec.as !== undefined ? { as: spec.as } : {}),
            ...(spec.attribute !== undefined ? { attribute: spec.attribute } : {}),
          })
          .catch((cause) => {
            throw new ActionRunError({
              code: "extract_failed",
              status: 422,
              message: redactSecrets(messageOf(cause), secrets),
              action: profile.id,
              field,
              evidence,
            })
          })
        extract[field] = redactSecrets(found.value ?? "", secrets)
      }
    }

    if (profile.evidence.text === true) {
      const snapshot = await browser.snapshot(sessionID)
      const artifact = repository.addArtifact({
        kind: "log",
        title: `${profile.id}:text`,
        producer: "harness",
        content: redactSecrets(snapshot.text, secrets),
        ...(input.runID ? { runID: input.runID } : {}),
        ...(input.taskID ? { taskID: input.taskID } : {}),
      })
      evidence.push(artifact.id)
    }

    const view = browser.get(sessionID)
    return {
      action: profile.id,
      tool: profile.tool,
      status: "success",
      origin: profile.origin,
      url: redactSecrets(view?.url ?? "", secrets),
      title: redactSecrets(view?.title ?? "", secrets),
      startedAt,
      finishedAt: Date.now(),
      steps,
      evidence,
      ...(extract !== undefined ? { extract } : {}),
    }
  }

  /**
   * The editor's preview (WA-8): the read-only part of the recipe, for real.
   *
   * `goto`, `waitFor` and `assert` drive the browser so the page is actually reached; the first step
   * that would change it — `fill`, `click`, `upload`, `submit` — is where it stops, and that step and
   * every one after it are reported as skipped. A `screenshot` captures a frame without keeping it,
   * because a preview files no evidence. A failure before the cut is reported in its step instead of
   * thrown: there is no run to fail, only a form to tell what went wrong.
   */
  const previewDrive = async (
    profile: ActionProfile,
    resolved: ResolvedActionInputs,
    input: ActionRunRequest,
  ): Promise<ActionPreviewResult> => {
    const sessionID = input.sessionID
    await browser.start({
      id: sessionID,
      project: input.project,
      ...(input.headed === true ? { headed: true } : {}),
    })
    try {
      const context: StepContext = {
        sessionID,
        values: resolved.values,
        images: resolved.images,
        // A preview never resolves a credential: the step that would use one is an effect, and the cut
        // lands before it.
        credentials: {},
      }
      const startedAt = Date.now()
      const steps: ActionStepReport[] = []
      let cut = false
      let broke = false

      for (const [index, step] of profile.steps.entries()) {
        const kind = stepKind(step)
        if (cut || broke || isEffectStep(step)) {
          steps.push({ index, kind, status: "skipped", attempts: 0, durationMs: 0 })
          cut = true
          continue
        }
        const stepStartedAt = Date.now()
        try {
          if ("screenshot" in step) await browser.frame(sessionID, { store: false })
          else await runStep(browser, profile, step, context)
          steps.push({ index, kind, status: "ok", attempts: 1, durationMs: Date.now() - stepStartedAt })
        } catch (cause) {
          steps.push({
            index,
            kind,
            status: "failed",
            attempts: 1,
            durationMs: Date.now() - stepStartedAt,
            error: messageOf(cause),
          })
          broke = true
        }
      }

      const view = browser.get(sessionID)
      return {
        action: profile.id,
        tool: profile.tool,
        status: "preview",
        origin: profile.origin,
        url: view?.url ?? "",
        title: view?.title ?? "",
        startedAt,
        finishedAt: Date.now(),
        steps,
      }
    } finally {
      // A preview is one shot: leaving it open holds the project's reservation, and the agent's
      // next run on the same project would only meet `browser_busy` instead of the page.
      await browser.close(sessionID).catch(() => undefined)
    }
  }

  return { list, run }
}

/** The steps that change the page: where a preview stops before it runs one (WA-8). */
const isEffectStep = (step: ActionStep): boolean =>
  "fill" in step || "click" in step || "upload" in step || "submit" in step

type StepContext = {
  sessionID: string
  values: Record<string, string>
  images: Record<string, string>
  credentials: Record<string, string>
}

const resolveProfile = (source: ActionProfilesSource, input: ActionRunRequest): ActionProfile => {
  const hasAction = typeof input.action === "string" && input.action !== ""
  const hasProfile = input.profile !== undefined
  if (hasAction && hasProfile)
    throw new ActionRunError({ code: "invalid_request", status: 400, message: "Provide an action or a profile, not both" })
  if (!hasAction && !hasProfile)
    throw new ActionRunError({ code: "invalid_request", status: 400, message: "An action or a profile is required" })
  if (hasAction) {
    const raw = source.profiles[input.action!]
    if (raw === undefined)
      throw new ActionRunError({ code: "unknown_action", status: 404, message: `No action profile "${input.action}"` })
    return validatedProfile(input.action!, raw)
  }
  // A raw profile is an editor's unsaved draft: a dry run or a preview may show it, nothing else.
  if (input.dryRun !== true && input.preview !== true)
    throw new ActionRunError({
      code: "invalid_request",
      status: 400,
      message: "A raw profile is only accepted for a dry run or a preview",
    })
  const raw = input.profile
  const id = isPlainObject(raw) && typeof raw.tool === "string" && raw.tool !== "" ? raw.tool : "action"
  return validatedProfile(id, raw)
}

const validatedProfile = (id: string, raw: unknown): ActionProfile => {
  const result = validateActionProfile(id, raw)
  if (result.ok) return result.profile
  throw new ActionRunError({
    code: result.code === "unsupported_kind" ? "unsupported_kind" : "invalid_action",
    status: 422,
    message: result.message,
    action: id,
  })
}

const runStep = async (
  browser: BrowserRuntime,
  profile: ActionProfile,
  step: ActionStep,
  context: StepContext,
): Promise<string | undefined> => {
  if ("goto" in step) {
    const url = substitute(profile, step.goto, context.values)
    if (!URL.canParse(url) || new URL(url).origin !== profile.origin)
      throw new ActionRunError({
        code: "origin_mismatch",
        status: 403,
        message: "That navigation leaves the profile's origin",
        action: profile.id,
        url,
      })
    await browser.navigate(context.sessionID, url)
    return undefined
  }
  if ("waitFor" in step) {
    await browser.waitFor(context.sessionID, step.waitFor, step.timeoutMs, step.state)
    return undefined
  }
  if ("fill" in step) {
    await fillStep(browser, profile, step.fill, step.timeoutMs, context)
    return undefined
  }
  if ("click" in step) {
    await browser.click(context.sessionID, step.click, step.timeoutMs)
    ensureOrigin(browser, context.sessionID, profile)
    return undefined
  }
  if ("upload" in step) {
    const match = UPLOAD_FROM.exec(step.upload.from)
    const file = match ? context.images[match[1]!] : undefined
    if (file === undefined)
      throw new ActionRunError({
        code: "unknown_input",
        status: 422,
        message: `Upload source "${step.upload.from}" is not available`,
        action: profile.id,
      })
    await browser.upload(context.sessionID, step.upload.selector, file, step.timeoutMs)
    return undefined
  }
  if ("submit" in step) {
    await browser.submit(context.sessionID, step.submit.selector, step.timeoutMs)
    ensureOrigin(browser, context.sessionID, profile)
    return undefined
  }
  if ("assert" in step) {
    const found = await browser.text(
      context.sessionID,
      step.assert.selector,
      step.timeoutMs === undefined ? undefined : { timeoutMs: step.timeoutMs },
    )
    const expected = step.assert.text === undefined ? undefined : substitute(profile, step.assert.text, context.values)
    if (expected !== undefined && found.value !== expected)
      throw new Error(`Expected "${expected}" but found "${found.value ?? ""}"`)
    return undefined
  }
  const { artifactId } = await browser.screenshot(context.sessionID, step.screenshot)
  return artifactId
}

const fillStep = async (
  browser: BrowserRuntime,
  profile: ActionProfile,
  fill: { selector: string; text?: string; credential?: string },
  timeoutMs: number | undefined,
  context: StepContext,
): Promise<void> => {
  if (fill.credential !== undefined) {
    const name = fill.credential === "{{credential}}" ? (profile.credential ?? "credential") : fill.credential
    const value = context.credentials[name]
    if (value === undefined)
      throw new ActionRunError({
        code: "credential_unavailable",
        status: 422,
        message: `The credential "${name}" is not available`,
        action: profile.id,
      })
    // A credential is bound to an origin: the page may have navigated between `goto` and this fill.
    ensureOrigin(browser, context.sessionID, profile)
    await browser.type(context.sessionID, fill.selector, value, timeoutMs)
    // The value is redacted already; the selector blacks the field out in every later capture.
    browser.protect(context.sessionID, { selector: fill.selector, value })
    return
  }
  const template = fill.text ?? ""
  if (referencesImageInput(template, profile.inputs))
    throw new ActionRunError({
      code: "image_in_text",
      status: 422,
      message: "An image input cannot be typed as text",
      action: profile.id,
    })
  const value = substitute(profile, template, context.values)
  if (value === "")
    throw new ActionRunError({
      code: "invalid_input",
      status: 422,
      message: "fill.text resolved to an empty value",
      action: profile.id,
    })
  await browser.type(context.sessionID, fill.selector, value, timeoutMs)
}

/**
 * The live-origin check: the URL the browser is on right now must still be the profile's origin.
 *
 * `goto` checks its own target before navigating, but a `click` or a `submit` can land somewhere
 * else, and a credential typed after that would go to the wrong site.
 */
const ensureOrigin = (browser: BrowserRuntime, sessionID: string, profile: ActionProfile): void => {
  const url = browser.get(sessionID)?.url ?? ""
  if (!URL.canParse(url) || new URL(url).origin !== profile.origin)
    throw new ActionRunError({
      code: "origin_mismatch",
      status: 403,
      message: "The browser left the profile's origin",
      action: profile.id,
      ...(url ? { url } : {}),
    })
}

const substitute = (profile: ActionProfile, template: string, values: Record<string, string>): string => {
  const result = substituteActionTemplate(template, { inputs: values, origin: profile.origin })
  if (!result.ok)
    throw new ActionRunError({ code: result.code, status: 422, message: result.message, action: profile.id })
  return result.value
}

const stepFailure = (
  profile: ActionProfile,
  step: ActionStep,
  index: number,
  cause: unknown,
  evidence: string[],
  secrets: string[],
): ActionRunError => {
  if (cause instanceof ActionRunError)
    return new ActionRunError({
      code: cause.code,
      status: cause.status,
      message: redactSecrets(cause.message, secrets),
      action: cause.action ?? profile.id,
      step: cause.step ?? stepKind(step),
      index: cause.index ?? index,
      ...(cause.field !== undefined ? { field: cause.field } : {}),
      ...(cause.guardCode !== undefined ? { guardCode: cause.guardCode } : {}),
      evidence,
      ...(cause.url !== undefined ? { url: cause.url } : {}),
    })
  if (cause instanceof NavigationBlockedError)
    return new ActionRunError({
      code: "navigation_blocked",
      status: 403,
      message: redactSecrets(cause.reason, secrets),
      action: profile.id,
      step: stepKind(step),
      index,
      evidence,
      ...(cause.url !== undefined ? { url: cause.url } : {}),
    })
  // A person stopping the run is not a step that failed: it is the run being called off, so it must
  // read as `stopped` and never be retried.
  if (cause instanceof BrowserError && cause.code === "stopped")
    return new ActionRunError({
      code: "stopped",
      status: 409,
      message: "The browser session was stopped",
      action: profile.id,
      step: stepKind(step),
      index,
      evidence,
    })
  return new ActionRunError({
    code: "step_failed",
    status: 422,
    message: redactSecrets(messageOf(cause), secrets),
    action: profile.id,
    step: stepKind(step),
    index,
    evidence,
  })
}

const inputFailure = (cause: unknown, profile: ActionProfile): unknown =>
  cause instanceof ActionInputError
    ? new ActionRunError({ code: cause.code, status: 422, message: cause.message, action: profile.id })
    : cause

const stoppedError = (profile: ActionProfile): ActionRunError =>
  new ActionRunError({ code: "stopped", status: 409, message: "The run was stopped", action: profile.id })

const isRetryable = (cause: unknown): boolean => {
  if (cause instanceof NavigationBlockedError) return true
  // A stop is never retried: the abort already closed the session, so a second attempt would only
  // meet `no_session` and bury the `stopped` code under a `step_failed`.
  if (cause instanceof BrowserError) return cause.code !== "stopped"
  if (cause instanceof ActionRunError) return !NON_RETRYABLE.has(cause.code)
  return true
}

const canRetry = (kind: ActionStepName): boolean => kind === "goto" || kind === "waitFor" || kind === "assert"

const stepKind = (step: ActionStep): ActionStepName =>
  "goto" in step
    ? "goto"
    : "waitFor" in step
      ? "waitFor"
      : "fill" in step
        ? "fill"
        : "click" in step
          ? "click"
          : "upload" in step
            ? "upload"
            : "submit" in step
              ? "submit"
              : "assert" in step
                ? "assert"
                : "screenshot"

const plannedReport = (step: ActionStep, index: number): ActionStepReport => ({
  index,
  kind: stepKind(step),
  status: "planned",
  attempts: 0,
  durationMs: 0,
})

const referencesImageInput = (template: string, inputs: Record<string, ActionInputKind>): boolean =>
  [...template.matchAll(TEMPLATE_INPUT)].some((match) => inputs[match[1]!] === "image")

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
