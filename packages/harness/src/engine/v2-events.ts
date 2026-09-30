import type { OpenCodeEvent, SessionMessageInfo as V2Message } from "@opencode/client"
import type { SessionMessageInfo } from "../engine-types"
import { toMessage } from "./v2-convert"

/**
 * OpenCode 2's session events as changes to the transcript the app renders (V2-21).
 *
 * 1.x streamed the transcript as `message.*` frames on each folder's stream; 2.x streams it on the
 * global `/api/event` as `session.*` events that name the assistant message and build it up piece by
 * piece. This mirrors the projection `@opencode/client`'s own store applies to them, on the 2.x
 * shapes, and hands the app each touched message through the same `toMessage` a refetch uses, so a
 * transcript built live and one read back from the engine cannot drift apart.
 *
 * Only the messages of a turn in flight are held, from the event that creates them until the
 * execution ends. An event about a message this stream never saw start (the app joined mid-turn,
 * or the stream dropped) comes back `stale`: the app reads the transcript again instead.
 */
export function createV2Transcript() {
  const held = new Map<string, Map<string, V2Message>>()
  // Admitted prompts wait here until the engine delivers them into the transcript.
  const inbox = new Map<string, V2Message>()
  const missed = new Set<string>()

  return {
    reduce(frame: { type?: string }): V2TranscriptChange | undefined {
      if (!frame.type?.startsWith("session.")) return
      const event = frame as OpenCodeEvent
      if (!("data" in event) || !event.data || !("sessionID" in event.data)) return
      const sessionID = event.data.sessionID
      const messages = held.get(sessionID) ?? new Map<string, V2Message>()
      held.set(sessionID, messages)
      const touched = (...changed: V2Message[]) => upsert(sessionID, changed)
      // Only the first miss per message asks for a refetch; the rest of its stream waits for that.
      const missing = (id: string): V2TranscriptChange => {
        if (missed.has(id)) return { sessionID, chars: 0 }
        missed.add(id)
        return { sessionID, chars: 0, stale: true }
      }
      const assistant = (messageID: string) => {
        const message = messages.get(messageID)
        return message?.type === "assistant" ? message : undefined
      }

      switch (event.type) {
        case "session.inbox.enqueued": {
          const item = event.data.item
          if (item.type === "user")
            inbox.set(event.data.inboxID, {
              id: event.data.inboxID,
              type: "user",
              ...item.payload,
              time: { created: event.created },
            })
          if (item.type === "synthetic")
            inbox.set(event.data.inboxID, {
              id: event.data.inboxID,
              type: "synthetic",
              ...item.payload,
              time: { created: event.created },
            })
          return { sessionID, chars: 0 }
        }
        case "session.inbox.cancelled":
          inbox.delete(event.data.inboxID)
          return { sessionID, chars: 0 }
        case "session.inbox.delivered": {
          const message = inbox.get(event.data.inboxID)
          inbox.delete(event.data.inboxID)
          if (!message) return missing(event.data.inboxID)
          // It joins the transcript when it is delivered, not when it was sent.
          message.time.created = event.created
          return touched(message)
        }
        case "session.step.started": {
          const existing = assistant(event.data.assistantMessageID)
          if (existing) {
            existing.agent = event.data.agent
            existing.model = event.data.model
            existing.error = undefined
            existing.finish = undefined
            existing.time = { created: event.data.started }
            if (event.data.snapshot) existing.snapshot = { ...existing.snapshot, start: event.data.snapshot }
            return touched(existing)
          }
          // A new step closes the one before it, which may never have said it ended.
          const previous = [...messages.values()].findLast(
            (message) => message.type === "assistant" && !message.time.completed,
          )
          if (previous?.type === "assistant") previous.time.completed = event.created
          const created: V2Message = {
            id: event.data.assistantMessageID,
            type: "assistant",
            agent: event.data.agent,
            model: event.data.model,
            ...(event.metadata ? { metadata: event.metadata } : {}),
            content: [],
            ...(event.data.snapshot ? { snapshot: { start: event.data.snapshot } } : {}),
            time: { created: event.data.started },
          }
          messages.set(created.id, created)
          return previous ? touched(previous, created) : touched(created)
        }
        case "session.step.ended": {
          const message = assistant(event.data.assistantMessageID)
          if (!message) return missing(event.data.assistantMessageID)
          message.time.completed = event.created
          message.finish = event.data.finish
          message.cost = event.data.cost
          message.tokens = event.data.tokens
          if (event.data.snapshot) message.snapshot = { ...message.snapshot, end: event.data.snapshot }
          return touched(message)
        }
        case "session.step.failed": {
          const message = assistant(event.data.assistantMessageID)
          if (!message) return missing(event.data.assistantMessageID)
          message.time.completed = event.created
          message.finish = event.data.finish ?? "error"
          message.error = event.data.error
          if (event.data.cost !== undefined && event.data.tokens !== undefined) {
            message.cost = event.data.cost
            message.tokens = event.data.tokens
          }
          return touched(message)
        }
        case "session.text.started":
        case "session.reasoning.started": {
          const message = assistant(event.data.assistantMessageID)
          if (!message) return missing(event.data.assistantMessageID)
          message.content.push(
            event.type === "session.text.started"
              ? { type: "text", text: "" }
              : { type: "reasoning", text: "", time: { created: event.created } },
          )
          return touched(message)
        }
        case "session.text.delta":
        case "session.reasoning.delta": {
          const message = assistant(event.data.assistantMessageID)
          const kind = event.type === "session.text.delta" ? "text" : "reasoning"
          const index = message?.content.findLastIndex((item) => item.type === kind) ?? -1
          const part = message?.content[index]
          if (!message || (part?.type !== "text" && part?.type !== "reasoning"))
            return missing(event.data.assistantMessageID)
          part.text += event.data.delta
          return {
            ...touched(message),
            chars: event.data.delta.length,
            // The id `toMessage` gives the part, so the app can write the slice straight to it.
            delta: { messageID: message.id, partID: `${message.id}:${index}`, text: event.data.delta },
          }
        }
        case "session.text.ended":
        case "session.reasoning.ended": {
          const message = assistant(event.data.assistantMessageID)
          const kind = event.type === "session.text.ended" ? "text" : "reasoning"
          const part = message?.content.findLast((item) => item.type === kind)
          if (!message || (part?.type !== "text" && part?.type !== "reasoning"))
            return missing(event.data.assistantMessageID)
          part.text = event.data.text
          if (part.type === "reasoning")
            part.time = { created: part.time?.created ?? event.created, completed: event.created }
          return touched(message)
        }
        case "session.tool.input.started": {
          const message = assistant(event.data.assistantMessageID)
          if (!message) return missing(event.data.assistantMessageID)
          message.content.push({
            type: "tool",
            id: event.data.id,
            name: event.data.name,
            time: { created: event.created },
            state: { status: "streaming", input: "" },
          })
          return touched(message)
        }
        case "session.tool.input.delta":
        case "session.tool.input.ended":
        case "session.tool.called":
        case "session.tool.progress":
        case "session.tool.success":
        case "session.tool.failed": {
          const message = assistant(event.data.assistantMessageID)
          const tool = message?.content.findLast((item) => item.type === "tool" && item.id === event.data.id)
          if (!message || tool?.type !== "tool") return missing(event.data.assistantMessageID)
          const state = tool.state
          if (event.type === "session.tool.input.delta" && state.status === "streaming")
            tool.state = { status: "streaming", input: state.input + event.data.delta }
          if (event.type === "session.tool.input.ended" && state.status === "streaming")
            tool.state = { status: "streaming", input: event.data.text }
          if (event.type === "session.tool.called") {
            tool.time = { ...tool.time, ran: event.created }
            tool.state = { status: "running", input: event.data.input, metadata: {} }
          }
          if (event.type === "session.tool.progress" && state.status === "running")
            tool.state = { ...state, metadata: event.data.metadata }
          if (event.type === "session.tool.success" && state.status === "running") {
            tool.state = {
              status: "completed",
              input: state.input,
              ...(event.data.metadata ? { metadata: event.data.metadata } : {}),
              content: event.data.content,
            }
            tool.time = { ...tool.time, completed: event.created }
          }
          if (event.type === "session.tool.failed" && (state.status === "streaming" || state.status === "running")) {
            tool.state = {
              status: "error",
              error: event.data.error,
              input: typeof state.input === "string" ? {} : state.input,
              ...(event.data.metadata ? { metadata: event.data.metadata } : {}),
              ...(event.data.content ? { content: event.data.content } : {}),
            }
            tool.time = { ...tool.time, completed: event.created }
          }
          return touched(message)
        }
        case "session.synthetic": {
          const created: V2Message = {
            id: messageID(event.id),
            type: "synthetic",
            text: event.data.text,
            ...(event.data.description ? { description: event.data.description } : {}),
            time: { created: event.created },
          }
          return touched(created)
        }
        case "session.instructions.updated": {
          if (event.data.text === undefined) return { sessionID, chars: 0 }
          const created: V2Message = {
            id: messageID(event.id),
            type: "system",
            text: event.data.text,
            time: { created: event.created },
          }
          return touched(created)
        }
        case "session.shell.started": {
          const created: V2Message = {
            id: messageID(event.id),
            type: "shell",
            shellID: event.data.shell.id,
            command: event.data.shell.command,
            status: event.data.shell.status,
            time: { created: event.created },
          }
          messages.set(created.id, created)
          return touched(created)
        }
        case "session.shell.ended": {
          const shell = [...messages.values()].findLast(
            (message) => message.type === "shell" && message.shellID === event.data.shell.id,
          )
          if (shell?.type !== "shell") return missing(event.data.shell.id)
          shell.status = event.data.shell.status
          shell.output = event.data.output
          shell.time.completed = event.created
          return touched(shell)
        }
        case "session.compaction.ended": {
          // Only a finished compaction has anything to show (see `toMessage`).
          const created: V2Message = {
            id: messageID(event.id),
            type: "compaction",
            status: "completed",
            reason: event.data.reason,
            model: event.data.model,
            summary: event.data.text,
            recent: event.data.recent,
            cost: event.data.cost,
            tokens: event.data.tokens,
            time: { created: event.created },
          }
          return touched(created)
        }
        case "session.revert.committed": {
          const to = event.data.to
          held.delete(sessionID)
          // Message ids sort by time, so everything from the revert point on goes.
          return {
            sessionID,
            chars: 0,
            apply: (data: SessionMessageInfo[]) => data.filter((message) => message.id < to),
          }
        }
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          held.delete(sessionID)
          missed.clear()
          return { sessionID, chars: 0 }
        case "session.execution.started":
        case "session.step.streamed":
        case "session.retry.scheduled":
        case "session.usage.updated":
        case "session.compaction.started":
        case "session.compaction.delta":
        case "session.compaction.failed":
          return { sessionID, chars: 0 }
      }
      // Session lifecycle (created, renamed, deleted…) is not the transcript's business.
      return
    },
  }
}

export type V2TranscriptChange = {
  sessionID: string
  /** What this event added to the text of the turn, for the running token estimate. */
  chars: number
  apply?: (data: SessionMessageInfo[]) => SessionMessageInfo[]
  delta?: { messageID: string; partID: string; text: string }
  /** The event is about a message this stream did not see start: read the transcript again. */
  stale?: true
}

/** The messages as the app renders them, each replacing its older copy or joining at the end. */
function upsert(sessionID: string, messages: V2Message[]) {
  const converted = messages.flatMap((message) => toMessage(message) ?? [])
  return {
    sessionID,
    chars: 0,
    apply: (data: SessionMessageInfo[]) =>
      converted.reduce((current, message) => {
        const index = current.findIndex((item) => item.id === message.id)
        if (index === -1) return [...current, message]
        return current.map((item, position) => (position === index ? message : item))
      }, data),
  }
}

/** The id 2.x gives a message an event creates on its own, as its store does. */
function messageID(eventID: string) {
  return eventID.replace(/^evt_/, "msg_")
}
