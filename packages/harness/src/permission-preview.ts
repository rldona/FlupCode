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

const text = (value: unknown) => (typeof value === "string" ? value : undefined)

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
