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
import type { ActionProfilesSource } from "./config-files"
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
])

export type ActionRunRequest = {
  action?: string
  profile?: unknown
  inputs?: Record<string, unknown>
  sessionID: string
  project: string
  headed?: boolean
  dryRun?: boolean
}

export type ActionStepReport = {
  index: number
  kind: ActionStepName
  status: "ok" | "failed" | "planned"
  attempts: number
  durationMs: number
  screenshot?: string
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

export type ActionRunner = {
  list(): { profiles: ActionProfile[]; rejected: Array<{ id: string; code: string; message: string }> }
  run(input: ActionRunRequest): Promise<ActionRunResult | ActionDryRunResult>
}

export type ActionRunnerOptions = {
  browser: BrowserRuntime
  repository: Pick<SqliteRoutineRepository, "addArtifact" | "getArtifact">
  credentials: ActionCredentialResolver
  loadProfiles: () => ActionProfilesSource
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

  const list = () => {
    const source = loadProfiles()
    const profiles: ActionProfile[] = []
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
      profiles.push(result.profile)
    }
    return { profiles, rejected }
  }

  const run = async (input: ActionRunRequest): Promise<ActionRunResult | ActionDryRunResult> => {
    const source = loadProfiles()
    const profile = resolveProfile(source, input)
    const provided = isPlainObject(input.inputs) ? input.inputs : {}
    const resolved = await resolveActionInputs({ profile, provided, repository }).catch((cause) => {
      throw inputFailure(cause, profile)
    })
    const secrets: string[] = []
    try {
      const verdict = await runActionGuards({
        guards: profile.guards,
        configDir: source.configDir,
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

      return await drive(profile, resolved, input, secrets)
    } finally {
      resolved.cleanup()
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

    await browser.start({ id: sessionID, project: input.project, ...(input.headed === true ? { headed: true } : {}) })
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
      const kind = stepKind(step)
      const stepStartedAt = Date.now()
      const allowed = canRetry(kind) ? MAX_STEP_ATTEMPTS : 1
      let attempt = 0
      let explicit: string | undefined
      let failure: unknown
      while (attempt < allowed) {
        attempt += 1
        try {
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

  return { list, run }
}

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
  if (input.dryRun !== true)
    throw new ActionRunError({
      code: "invalid_request",
      status: 400,
      message: "A raw profile is only accepted for a dry run",
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

const isRetryable = (cause: unknown): boolean => {
  if (cause instanceof NavigationBlockedError || cause instanceof BrowserError) return true
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
