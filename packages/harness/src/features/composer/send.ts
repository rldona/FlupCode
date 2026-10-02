import type { createClient } from "../../client"
import { pendingPrompts, type Delivery } from "../../pending-prompts"
import type { PermissionRule } from "../../permission-modes"
import type { Attachment } from "../../types"

type ModelRef = { providerID: string; id: string; variant?: string }

/** A prompt for a session that already exists, and how the engine should take it. */
export type OutgoingPrompt = {
  sessionID: string
  directory: string | undefined
  /** What the reader typed, which the transcript shows until the engine projects the message. */
  text: string
  /** What the engine is sent: the text with its pasted blocks put back. */
  body: string
  files: Attachment[]
  model: ModelRef | undefined
  /** The named instructions the turn runs under (H-37). */
  instructions: Record<string, string | undefined>
  /** Tells the caller the prompt is about to be listed, after the session is ready for it. */
  onReady?: () => void
} & (
  | {
      /**
       * A plain chat: no inbox, agent or permission mode. A line sent while the chat answers interrupts
       * the turn in flight and starts its own, so the answer is about this line.
       */
      chat: true
      interrupt: boolean
    }
  | {
      chat?: false
      /** The prompt's own id, which the pending prompt and the engine's message share. */
      id: string
      agent: string | undefined
      permission: PermissionRule[]
      /** The folder the permission mode is set in, which for a session off the list may be unknown. */
      permissionDirectory: string | undefined
      /** Undefined when the session is idle, where delivery makes no difference. */
      delivery: Delivery | undefined
      /** Tells the caller the prompt is listed and on its way, before the engine answers. */
      onListed?: () => void
      /** Undoes what the caller did for a prompt the engine refused, before the failure is thrown. */
      onFailed?: () => Promise<void>
    }
)

/**
 * Sends a prompt to the engine (UX-00): the one path for the composer, in Code, Chat and Cowork, and
 * for every split pane. Creating the session, and what the composer shows while it waits, stay with the
 * caller; how the prompt reaches the engine does not.
 *
 * Code and Cowork prompts are listed as pending before they go, so the transcript shows them at once;
 * the engine delivers them itself (V2-41), a steer joining the running execution at its next boundary
 * and a queued one waiting in the session's inbox. A send that fails takes its pending prompt back.
 */
export async function sendPrompt(client: ReturnType<typeof createClient>, prompt: OutgoingPrompt) {
  const files = prompt.files.map((file) => ({ uri: file.uri, name: file.name }))
  if (prompt.chat) {
    if (prompt.interrupt)
      await client.session.abort({ sessionID: prompt.sessionID, directory: prompt.directory }).catch(() => {})
    prompt.onReady?.()
    await client.session.send({
      sessionID: prompt.sessionID,
      directory: prompt.directory,
      text: prompt.body,
      instructions: prompt.instructions,
      files,
      ...(prompt.model ? { model: prompt.model } : {}),
    })
    return
  }
  await client.session.setPermission({
    sessionID: prompt.sessionID,
    permission: prompt.permission,
    directory: prompt.permissionDirectory,
  })
  prompt.onReady?.()
  pendingPrompts.add({
    id: prompt.id,
    sessionID: prompt.sessionID,
    directory: prompt.directory,
    text: prompt.text,
    files: prompt.files,
    agent: prompt.agent,
    ...(prompt.model ? { model: prompt.model } : {}),
    delivery: prompt.delivery,
    ...(prompt.delivery === "queue" ? { held: true } : {}),
  })
  prompt.onListed?.()
  try {
    await client.session.send({
      sessionID: prompt.sessionID,
      directory: prompt.directory,
      id: prompt.id,
      text: prompt.body,
      agent: prompt.agent,
      instructions: prompt.instructions,
      ...(prompt.model ? { model: prompt.model } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(prompt.delivery ? { delivery: prompt.delivery } : {}),
    })
  } catch (cause) {
    pendingPrompts.remove(prompt.id)
    await prompt.onFailed?.()
    throw cause
  }
}
