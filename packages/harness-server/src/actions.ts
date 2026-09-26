/**
 * The `flupcode.actions` profile and the web recipe it declares (WA-2).
 *
 * Pure by design: it validates the envelope and the step grammar, and substitutes `{{…}}`
 * placeholders. It never launches a browser, reads a credential or runs a step, so the decisions a
 * profile makes can be tested on their own; the runner and the plugin build on them.
 */

export type ActionInputKind = "string" | "image"

export type ActionStepName = "goto" | "waitFor" | "fill" | "click" | "upload" | "submit" | "assert" | "screenshot"

export type ActionStep =
  | { goto: string; timeoutMs?: number; sensitive?: boolean }
  | { waitFor: string; timeoutMs?: number; state?: "attached" | "visible"; sensitive?: boolean }
  | { fill: { selector: string; text?: string; credential?: string }; timeoutMs?: number; sensitive?: boolean }
  | { click: string; timeoutMs?: number; sensitive?: boolean }
  | { upload: { selector: string; from: string }; timeoutMs?: number }
  | { submit: { selector: string }; timeoutMs?: number }
  | { assert: { selector: string; text?: string }; timeoutMs?: number }
  | { screenshot: string }

export type ActionExtract = { selector: string; as?: "text" | "html" | "attribute"; attribute?: string }

export type ActionEvidence = { screenshots?: "each" | "failure" | "none"; text?: boolean }

export type ActionProfile = {
  id: string
  tool: string
  description: string
  kind: "browser"
  origin: string
  credential?: string
  inputs: Record<string, ActionInputKind>
  steps: ActionStep[]
  extract?: Record<string, ActionExtract>
  guards: string[]
  sensitive: boolean
  availability: "host" | "desktop"
  evidence: ActionEvidence
}

export type ActionValidation = { ok: true; profile: ActionProfile } | { ok: false; code: string; message: string }

export const DEFAULT_STEP_TIMEOUT_MS = 15_000
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000
export const MAX_STEP_TIMEOUT_MS = 120_000

const ACTION_ID = /^[A-Za-z0-9_-]{1,64}$/
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/
const INPUT_NAME = /^[A-Za-z0-9_-]{1,64}$/
const RESERVED_INPUT = "origin"
const ACTION_KEYS = ["goto", "waitFor", "fill", "click", "upload", "submit", "assert", "screenshot"] as const

/**
 * Tools the engine already owns. The plugin registers one tool per profile in the same namespace, so a
 * profile named like a built-in would replace it instead of adding one. This is a safety net against
 * that collision, not a policy about which names a profile may use.
 */
const RESERVED_TOOLS = new Set([
  "bash",
  "read",
  "edit",
  "write",
  "glob",
  "grep",
  "task",
  "webfetch",
  "websearch",
  "question",
  "skill",
  "todowrite",
])
const TEMPLATE_INPUT = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g
const TEMPLATE_LEFT = /\{\{[\s\S]*?\}\}/
const UPLOAD_FROM = /^\{\{\s*([A-Za-z0-9_-]+)\s*\}\}$/

/** Optional keys a step accepts, on top of the one action key. The union above is the authority. */
const STEP_OPTIONS: Record<ActionStepName, readonly string[]> = {
  goto: ["timeoutMs", "sensitive"],
  waitFor: ["timeoutMs", "state", "sensitive"],
  fill: ["timeoutMs", "sensitive"],
  click: ["timeoutMs", "sensitive"],
  upload: ["timeoutMs"],
  submit: ["timeoutMs"],
  assert: ["timeoutMs"],
  screenshot: [],
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The origin a profile is bound to, in the one shape the runtime compares.
 *
 * It does not look the host up: WA-1's egress guard decides at navigation time, and doing DNS here
 * would make loading a profile a network call. Only the URL itself is normalized.
 */
export function normalizeActionOrigin(value: unknown): { ok: true; origin: string } | { ok: false; message: string } {
  if (typeof value !== "string" || value.trim() === "") return { ok: false, message: "An origin is required" }
  if (!URL.canParse(value)) return { ok: false, message: "That origin is not a valid URL" }
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { ok: false, message: "Only http and https origins are allowed" }
  if (url.username !== "" || url.password !== "") return { ok: false, message: "An origin cannot carry credentials" }
  if (url.pathname !== "" && url.pathname !== "/") return { ok: false, message: "An origin cannot carry a path" }
  if (url.search !== "" || url.hash !== "")
    return { ok: false, message: "An origin cannot carry a query or a fragment" }
  return { ok: true, origin: url.origin }
}

export function validateActionProfile(id: string, raw: unknown): ActionValidation {
  if (!isPlainObject(raw)) return fail("invalid_profile", "A profile must be an object")

  // The id becomes part of the approval resource (`origin:id`), so a wildcard or separator here would
  // widen what "Allow always" approves beyond the action it names.
  if (typeof id !== "string" || !ACTION_ID.test(id))
    return fail("invalid_id", "id must match ^[A-Za-z0-9_-]{1,64}$")

  const tool = raw.tool
  if (typeof tool !== "string" || !TOOL_NAME.test(tool))
    return fail("invalid_tool", "tool must match ^[a-zA-Z0-9_-]{1,64}$")
  if (RESERVED_TOOLS.has(tool))
    return fail("reserved_tool", `tool "${tool}" collides with an engine tool`)

  // The refusal at load. An `api` or `mcp` profile is the same envelope with a backend this build
  // does not have, so it is named and refused rather than silently skipped.
  if (raw.kind !== "browser") return fail("unsupported_kind", 'Only kind "browser" is supported')

  const inputs = readInputs(raw.inputs)
  if (!inputs.ok) return fail("invalid_inputs", inputs.message)

  const credential = typeof raw.credential === "string" && raw.credential !== "" ? raw.credential : undefined

  const origin = normalizeActionOrigin(raw.origin)
  if (!origin.ok) return fail("invalid_origin", origin.message)

  const steps = readSteps(raw.steps, inputs.inputs, credential)
  if (!steps.ok) return steps

  const extract = readExtract(raw.extract)
  if (!extract.ok) return fail("invalid_extract", extract.message)

  const guards = readGuards(raw.guards)
  if (!guards.ok) return fail("invalid_guards", guards.message)

  const evidence = readEvidence(raw.evidence)
  if (!evidence.ok) return fail("invalid_evidence", evidence.message)

  const availability = raw.availability
  if (availability !== undefined && availability !== "host" && availability !== "desktop")
    return fail("invalid_availability", 'availability must be "host" or "desktop"')

  if (raw.sensitive !== undefined && typeof raw.sensitive !== "boolean")
    return fail("invalid_sensitive", "sensitive must be a boolean")

  const description =
    typeof raw.description === "string" && raw.description.trim() ? raw.description : `Run the "${id}" web action.`
  // A recipe that acts is sensitive even when it also reads: a `submit` plus an `extract` is not a
  // read-only action. Only the steps that change the page count, not `goto`/`waitFor`/`assert`/`screenshot`.
  const markedSensitive = steps.steps.some((step) => "sensitive" in step && step.sensitive === true)
  const hasEffect = steps.steps.some(
    (step) => "fill" in step || "click" in step || "upload" in step || "submit" in step,
  )
  // An explicit `sensitive: false` cannot win over the recipe: an action with those steps or a
  // credential needs the strong permission, and downgrading it here would approve less than it acts.
  if (raw.sensitive === false && (hasEffect || credential !== undefined))
    return fail("invalid_sensitive", "an action with side effects cannot be marked as not sensitive")
  const sensitive =
    typeof raw.sensitive === "boolean" ? raw.sensitive : markedSensitive || hasEffect || credential !== undefined

  return {
    ok: true,
    profile: {
      id,
      tool,
      description,
      kind: "browser",
      origin: origin.origin,
      ...(credential !== undefined ? { credential } : {}),
      inputs: inputs.inputs,
      steps: steps.steps,
      ...(extract.extract !== undefined ? { extract: extract.extract } : {}),
      guards: guards.guards,
      sensitive,
      availability: availability ?? "host",
      evidence: evidence.evidence,
    },
  }
}

export function substituteActionTemplate(
  template: string,
  context: { inputs: Record<string, string>; origin: string },
): { ok: true; value: string } | { ok: false; code: string; message: string } {
  let missing: string | undefined
  const value = template.replace(TEMPLATE_INPUT, (match, key: string) => {
    if (key === "origin") return context.origin
    // `hasOwn` rather than a plain lookup: `{{constructor}}` or `{{toString}}` must not resolve off
    // the prototype, and an absent key stays unknown whether it was never declared or shadowed.
    if (!Object.hasOwn(context.inputs, key)) {
      missing ??= key
      return match
    }
    const input = context.inputs[key]
    if (input === undefined || input === "") {
      missing ??= key
      return match
    }
    return input
  })
  if (missing !== undefined) return { ok: false, code: "unknown_input", message: `Unknown input "${missing}"` }
  if (TEMPLATE_LEFT.test(value))
    return { ok: false, code: "invalid_template", message: "The template has an unresolved placeholder" }
  return { ok: true, value }
}

const fail = (code: string, message: string): ActionValidation => ({ ok: false, code, message })

function readInputs(value: unknown): { ok: true; inputs: Record<string, ActionInputKind> } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, inputs: {} }
  if (!isPlainObject(value)) return { ok: false, message: "inputs must be an object" }
  const inputs: Record<string, ActionInputKind> = {}
  for (const [name, kind] of Object.entries(value)) {
    // The name reaches a file path, so it is restricted to a shape that cannot traverse: no dots, no
    // slashes, nothing that resolves to a parent directory.
    if (!INPUT_NAME.test(name)) return { ok: false, message: `Input "${name}" must match ^[A-Za-z0-9_-]{1,64}$` }
    if (name === RESERVED_INPUT) return { ok: false, message: `Input "${RESERVED_INPUT}" is reserved for the profile origin` }
    if (kind !== "string" && kind !== "image")
      return { ok: false, message: `Input "${name}" must be "string" or "image"` }
    inputs[name] = kind
  }
  return { ok: true, inputs }
}

function readGuards(value: unknown): { ok: true; guards: string[] } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, guards: [] }
  if (!Array.isArray(value)) return { ok: false, message: "guards must be an array" }
  const guards: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string" || !entry) return { ok: false, message: "Every guard must be a module path" }
    guards.push(entry)
  }
  return { ok: true, guards }
}

function readEvidence(value: unknown): { ok: true; evidence: ActionEvidence } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, evidence: { screenshots: "each" } }
  if (!isPlainObject(value)) return { ok: false, message: "evidence must be an object" }
  const screenshots = value.screenshots
  if (screenshots !== undefined && screenshots !== "each" && screenshots !== "failure" && screenshots !== "none")
    return { ok: false, message: 'evidence.screenshots must be "each", "failure" or "none"' }
  const text = value.text
  if (text !== undefined && typeof text !== "boolean") return { ok: false, message: "evidence.text must be a boolean" }
  return { ok: true, evidence: { screenshots: screenshots ?? "each", ...(text !== undefined ? { text } : {}) } }
}

function readExtract(
  value: unknown,
): { ok: true; extract?: Record<string, ActionExtract> } | { ok: false; message: string } {
  if (value === undefined) return { ok: true }
  if (!isPlainObject(value)) return { ok: false, message: "extract must be an object" }
  const extract: Record<string, ActionExtract> = {}
  for (const [name, raw] of Object.entries(value)) {
    if (!isPlainObject(raw)) return { ok: false, message: `extract."${name}" must be an object` }
    if (typeof raw.selector !== "string" || !raw.selector)
      return { ok: false, message: `extract."${name}".selector is required` }
    const as = raw.as
    if (as !== undefined && as !== "text" && as !== "html" && as !== "attribute")
      return { ok: false, message: `extract."${name}".as must be "text", "html" or "attribute"` }
    const attribute = raw.attribute
    if (attribute !== undefined && typeof attribute !== "string")
      return { ok: false, message: `extract."${name}".attribute must be a string` }
    if (as === "attribute" && !attribute)
      return { ok: false, message: `extract."${name}".attribute is required when as is "attribute"` }
    extract[name] = {
      selector: raw.selector,
      ...(as !== undefined ? { as } : {}),
      ...(attribute !== undefined ? { attribute } : {}),
    }
  }
  return { ok: true, extract }
}

type StepResult = { ok: true; step: ActionStep } | { ok: false; code: string; message: string }

function readSteps(
  value: unknown,
  inputs: Record<string, ActionInputKind>,
  credential: string | undefined,
): { ok: true; steps: ActionStep[] } | { ok: false; code: string; message: string } {
  if (!Array.isArray(value) || value.length === 0)
    return { ok: false, code: "invalid_step", message: "steps must be a non-empty array" }
  const steps: ActionStep[] = []
  for (const [index, raw] of value.entries()) {
    const parsed = readStep(raw, inputs, credential, index)
    if (!parsed.ok) return parsed
    steps.push(parsed.step)
  }
  return { ok: true, steps }
}

function readStep(
  raw: unknown,
  inputs: Record<string, ActionInputKind>,
  credential: string | undefined,
  index: number,
): StepResult {
  const rejected = (message: string): StepResult => ({
    ok: false,
    code: "invalid_step",
    message: `Step ${index + 1}: ${message}`,
  })
  const rejectedUpload = (message: string): StepResult => ({
    ok: false,
    code: "invalid_upload",
    message: `Step ${index + 1}: ${message}`,
  })

  if (!isPlainObject(raw)) return rejected("must be an object")
  const present = ACTION_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(raw, key))
  if (present.length !== 1) return rejected("must name exactly one action")
  const action = present[0]!

  for (const key of Object.keys(raw)) {
    if (key === action) continue
    if (!STEP_OPTIONS[action].includes(key)) return rejected(`does not accept "${key}"`)
  }

  const timeoutMs = raw.timeoutMs
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_STEP_TIMEOUT_MS)
  )
    return rejected(`timeoutMs must be an integer between 1 and ${MAX_STEP_TIMEOUT_MS}`)
  const sensitive = raw.sensitive
  if (sensitive !== undefined && typeof sensitive !== "boolean") return rejected("sensitive must be a boolean")
  const timed = timeoutMs !== undefined ? { timeoutMs } : {}
  const flagged = sensitive !== undefined ? { sensitive } : {}

  switch (action) {
    case "goto": {
      if (typeof raw.goto !== "string" || !raw.goto) return rejected("goto must be a non-empty string")
      return { ok: true, step: { goto: raw.goto, ...timed, ...flagged } }
    }
    case "waitFor": {
      if (typeof raw.waitFor !== "string" || !raw.waitFor) return rejected("waitFor must be a non-empty selector")
      const state = raw.state
      if (state !== undefined && state !== "attached" && state !== "visible")
        return rejected('state must be "attached" or "visible"')
      return { ok: true, step: { waitFor: raw.waitFor, ...timed, ...(state !== undefined ? { state } : {}), ...flagged } }
    }
    case "fill": {
      if (!isPlainObject(raw.fill)) return rejected("fill must be an object")
      const fill = raw.fill
      if (typeof fill.selector !== "string" || !fill.selector) return rejected("fill.selector is required")
      const text = typeof fill.text === "string" ? fill.text : undefined
      const credentialValue = typeof fill.credential === "string" && fill.credential !== "" ? fill.credential : undefined
      if ((text !== undefined) === (credentialValue !== undefined))
        return rejected("fill needs exactly one of text or credential")
      if (credentialValue === "{{credential}}" && credential === undefined)
        return rejected("fill references {{credential}} but the profile declares no credential")
      return {
        ok: true,
        step: {
          fill: {
            selector: fill.selector,
            ...(text !== undefined ? { text } : {}),
            ...(credentialValue !== undefined ? { credential: credentialValue } : {}),
          },
          ...timed,
          ...flagged,
        },
      }
    }
    case "click": {
      if (typeof raw.click !== "string" || !raw.click) return rejected("click must be a non-empty selector")
      return { ok: true, step: { click: raw.click, ...timed, ...flagged } }
    }
    case "upload": {
      if (!isPlainObject(raw.upload)) return rejectedUpload("upload must be an object")
      const upload = raw.upload
      if (typeof upload.selector !== "string" || !upload.selector)
        return rejectedUpload("upload.selector is required")
      if (typeof upload.from !== "string") return rejectedUpload("upload.from must reference an image input")
      const match = UPLOAD_FROM.exec(upload.from)
      if (!match) return rejectedUpload("upload.from must be a single {{name}} placeholder")
      if (inputs[match[1]!] !== "image")
        return rejectedUpload(`upload.from references "${match[1]}" which is not an image input`)
      return { ok: true, step: { upload: { selector: upload.selector, from: upload.from }, ...timed } }
    }
    case "submit": {
      if (!isPlainObject(raw.submit)) return rejected("submit must be an object")
      if (typeof raw.submit.selector !== "string" || !raw.submit.selector)
        return rejected("submit.selector is required")
      return { ok: true, step: { submit: { selector: raw.submit.selector }, ...timed } }
    }
    case "assert": {
      if (!isPlainObject(raw.assert)) return rejected("assert must be an object")
      if (typeof raw.assert.selector !== "string" || !raw.assert.selector)
        return rejected("assert.selector is required")
      const text = raw.assert.text
      if (text !== undefined && typeof text !== "string") return rejected("assert.text must be a string")
      return {
        ok: true,
        step: { assert: { selector: raw.assert.selector, ...(text !== undefined ? { text } : {}) }, ...timed },
      }
    }
    case "screenshot": {
      if (typeof raw.screenshot !== "string" || !raw.screenshot)
        return rejected("screenshot must be a non-empty label")
      return { ok: true, step: { screenshot: raw.screenshot } }
    }
    default:
      return rejected("is not a supported action")
  }
}
