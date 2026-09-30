import type {
  SessionInfo as V2Session,
  SessionMessageAssistant as V2Assistant,
  SessionMessageInfo as V2Message,
  ToolContent as V2ToolContent,
} from "@opencode/client"
import type { SessionInfo, SessionMessageInfo } from "../engine-types"

/**
 * OpenCode 2's session and message shapes, turned into the ones the app renders today (V2-20).
 *
 * The app was built on the 1.x engine's `/api` shapes, which OpenCode 2 grew out of, so most fields
 * carry over. What does not: tool states are `streaming` where the app knows `pending`, errors are
 * structured, text has no id, permissions are `{action, resource, effect}` rules, and a few message
 * kinds are new. Kinds the app has no view for (`idle`, `location-switched`, `skill`) are dropped;
 * the turn's outcome reaches the app through events instead (V2-21).
 */
export function toSession(session: V2Session): SessionInfo {
  return {
    id: session.id,
    ...(session.parentID ? { parentID: session.parentID } : {}),
    projectID: session.projectID,
    ...(session.agent ? { agent: session.agent } : {}),
    ...(session.model ? { model: session.model } : {}),
    cost: Number(session.cost),
    tokens: session.tokens,
    time: {
      created: session.time.created,
      updated: session.time.updated,
      ...(session.time.archived ? { archived: session.time.archived } : {}),
    },
    title: session.title ?? "",
    location: { directory: session.location.directory },
    ...(session.subpath ? { subpath: session.subpath } : {}),
    ...(session.permissions
      ? {
          permission: session.permissions.map((rule) => ({
            permission: rule.action,
            pattern: rule.resource,
            action: rule.effect,
          })),
        }
      : {}),
  }
}

/** Oldest first, with the kinds the app has no view for left out. */
export function toMessages(messages: readonly V2Message[]) {
  return messages.flatMap((message) => {
    const converted = toMessage(message)
    return converted ? [converted] : []
  })
}

export function toMessage(message: V2Message): SessionMessageInfo | undefined {
  const base = { id: message.id, time: { created: message.time.created }, ...metadataOf(message) }
  if (message.type === "user")
    return {
      ...base,
      type: "user",
      text: message.text,
      ...(message.files?.length
        ? {
            files: message.files.map((file) => ({
              uri: file.source.type === "uri" ? file.source.uri : `data:${file.mime};base64,${file.data}`,
              mime: file.mime,
              ...(file.name ? { name: file.name } : {}),
              ...(file.description ? { description: file.description } : {}),
            })),
          }
        : {}),
      ...(message.agents?.length ? { agents: message.agents.map((agent) => ({ name: agent.name })) } : {}),
    }
  if (message.type === "assistant") return toAssistant(message)
  if (message.type === "synthetic") return { ...base, type: "synthetic", sessionID: "", text: message.text }
  if (message.type === "system") return { ...base, type: "system", text: message.text }
  if (message.type === "agent-switched") return { ...base, type: "agent-switched", agent: message.agent }
  if (message.type === "model-switched") return { ...base, type: "model-switched", model: message.model }
  if (message.type === "shell")
    return {
      ...base,
      time: { created: message.time.created, ...(message.time.completed ? { completed: message.time.completed } : {}) },
      type: "shell",
      callID: message.shellID,
      command: message.command,
      output: message.output?.output ?? "",
    }
  // Only a finished compaction has a summary to show; one still running, or failed, has none.
  if (message.type === "compaction" && message.status === "completed")
    return { ...base, type: "compaction", reason: message.reason, summary: message.summary, recent: message.recent }
  return undefined
}

function toAssistant(message: V2Assistant): SessionMessageInfo {
  return {
    id: message.id,
    ...metadataOf(message),
    time: {
      created: message.time.created,
      ...(message.time.completed ? { completed: message.time.completed } : {}),
    },
    type: "assistant",
    agent: message.agent,
    model: message.model,
    content: message.content.map((item, index) => {
      // 2.x text and reasoning carry no id; the app keys content by it, and the position is stable.
      const id = `${message.id}:${index}`
      if (item.type === "text") return { type: "text" as const, id, text: item.text }
      if (item.type === "reasoning") return { type: "reasoning" as const, id, text: item.text }
      return {
        type: "tool" as const,
        id: item.id,
        name: item.name,
        state: toolState(item.state),
        time: item.time,
      }
    }),
    ...(message.snapshot ? { snapshot: message.snapshot } : {}),
    ...(message.finish ? { finish: message.finish } : {}),
    ...(message.cost !== undefined ? { cost: Number(message.cost) } : {}),
    ...(message.tokens ? { tokens: message.tokens } : {}),
    ...(message.error ? { error: { type: "unknown" as const, message: message.error.message } } : {}),
  }
}

type V2Tool = Extract<V2Assistant["content"][number], { type: "tool" }>

function toolState(state: V2Tool["state"]) {
  if (state.status === "streaming") return { status: "pending" as const, input: state.input }
  if (state.status === "running")
    return { status: "running" as const, input: state.input, structured: state.metadata, content: [] }
  if (state.status === "completed")
    return {
      status: "completed" as const,
      input: state.input,
      content: toolContent(state.content),
      structured: state.metadata ?? {},
    }
  return {
    status: "error" as const,
    input: state.input,
    content: toolContent(state.content ?? []),
    structured: state.metadata ?? {},
    error: { type: "unknown" as const, message: state.error.message },
  }
}

/** 2.x lets a file result's `name` be `null`; the app's shape only knows it missing. */
function toolContent(items: readonly V2ToolContent[]) {
  return items.map((item) => (item.type === "file" ? { ...item, name: item.name ?? undefined } : item))
}

function metadataOf(message: V2Message) {
  return message.metadata ? { metadata: message.metadata } : {}
}
