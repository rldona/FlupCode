import type { PermissionV2Request, SessionMessageInfo } from "./engine-types"

/**
 * What the agent is actually asking to do. The request itself only carries an action and the
 * resources it touches, which for an edit is a bare path: approving that is approving a change
 * nobody has seen. The tool call behind the request is already in the transcript, so the dock reads
 * the arguments from there and shows the command or the diff.
 */
export type PermissionPreview =
  | { kind: "command"; command: string }
  | { kind: "edit"; path: string; before: string; after: string }
  | { kind: "write"; path: string; content: string }
  | { kind: "url"; url: string }
  | { kind: "resources"; resources: string[] }
  | {
      kind: "browser"
      origin: string
      action: string
      tool?: string
      description?: string
      sensitive?: boolean
      steps?: Array<{ index: number; kind: string; selector?: string; credential?: string }>
      screenshot?: string
    }

const text = (value: unknown) => (typeof value === "string" ? value : undefined)

/**
 * A screenshot worth putting in an `<img>`, kept only when it cannot reach outside the data URI or a
 * secure origin. The plugin's metadata is untyped, so a `javascript:` or remote `http:` source would
 * otherwise be painted as an image.
 */
export function previewImage(src: string): string | undefined {
  return src.startsWith("data:image/") || src.startsWith("https:") ? src : undefined
}

/** A browser effect step, kept only when its index and kind are of the type the plugin sends. */
function browserStep(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  if (!("index" in value) || !("kind" in value)) return undefined
  if (typeof value.index !== "number" || typeof value.kind !== "string") return undefined
  const selector = "selector" in value ? text(value.selector) : undefined
  const credential = "credential" in value ? text(value.credential) : undefined
  return {
    index: value.index,
    kind: value.kind,
    ...(selector !== undefined ? { selector } : {}),
    ...(credential !== undefined ? { credential } : {}),
  }
}

const BROWSER_METADATA_KEYS = [
  "kind",
  "origin",
  "action",
  "tool",
  "description",
  "sensitive",
  "steps",
  "screenshot",
] as const

/** The arguments of the tool call the request came from, when the transcript holds it. */
function toolInput(request: PermissionV2Request, messages: SessionMessageInfo[] | undefined) {
  const source = request.source
  if (!source || source.type !== "tool") return undefined
  const message = messages?.find((entry) => entry.id === source.messageID)
  if (message?.type !== "assistant") return undefined
  const part = message.content.find((entry) => entry.type === "tool" && entry.id === source.callID)
  if (!part || part.type !== "tool") return undefined
  return { name: part.name, input: (part.state.input ?? {}) as Record<string, unknown> }
}

export function permissionPreview(
  request: PermissionV2Request,
  messages: SessionMessageInfo[] | undefined,
): PermissionPreview {
  const call = toolInput(request, messages)
  const resource = request.resources[0]
  // The request travels as untyped JSON, so a non-object `metadata` must not reach the `key in` guard.
  const metadata = request.metadata && typeof request.metadata === "object" ? request.metadata : {}

  // A browser action asks before anything runs and carries its own summary, so the dock can say what
  // page acts and which effects it has without waiting for the transcript. The plugin's metadata is
  // untyped, so every field is read behind a guard; an empty one falls through to the resources.
  const browser =
    request.action === "browser" || request.action === "browser_sensitive" || metadata.kind === "browser"
  if (browser) {
    const origin = text(metadata.origin) ?? resource ?? ""
    const action = text(metadata.action) ?? request.action
    const tool = text(metadata.tool)
    const description = text(metadata.description)
    const sensitive = typeof metadata.sensitive === "boolean" ? metadata.sensitive : undefined
    const steps = Array.isArray(metadata.steps) ? metadata.steps.flatMap((step) => browserStep(step) ?? []) : []
    const screenshot = text(metadata.screenshot)
    const hasMetadata = BROWSER_METADATA_KEYS.some((key) => key in metadata)
    if (origin !== "" || hasMetadata)
      return {
        kind: "browser",
        origin,
        action,
        ...(tool !== undefined ? { tool } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(sensitive !== undefined ? { sensitive } : {}),
        ...(steps.length > 0 ? { steps } : {}),
        ...(screenshot ? { screenshot } : {}),
      }
  }

  // A bash request carries the command as its resource, so it previews even before the transcript
  // catches up with the call.
  if (request.action === "bash" || call?.name === "bash") {
    const command = text(call?.input.command) ?? resource
    if (command) return { kind: "command", command }
  }

  if (call?.name === "edit") {
    const before = text(call.input.oldString)
    const after = text(call.input.newString)
    if (before !== undefined && after !== undefined)
      return { kind: "edit", path: text(call.input.path) ?? resource ?? "", before, after }
  }

  if (call?.name === "write") {
    const content = text(call.input.content)
    if (content !== undefined) return { kind: "write", path: text(call.input.path) ?? resource ?? "", content }
  }

  if (call?.name === "webfetch" || request.action === "webfetch") {
    const url = text(call?.input.url) ?? resource
    if (url) return { kind: "url", url }
  }

  return { kind: "resources", resources: request.resources }
}

/**
 * The patterns "Allow always" would remember, which is what makes that button hard to trust: on an
 * edit the engine saves `*`, so one click grants every later edit in the project, not this file.
 */
export function alwaysScope(request: PermissionV2Request) {
  const save = request.save ?? []
  if (save.length === 0) return undefined
  return save.includes("*") ? { wide: true, patterns: save } : { wide: false, patterns: save }
}
