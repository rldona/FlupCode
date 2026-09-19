import { For, Show, type Component } from "solid-js"
import type { SessionInfo } from "../engine-types"
import { t } from "../i18n"

type SubagentListProps = {
  sessions: SessionInfo[] | undefined
  onOpen: (id: string) => void
  /** Hides listed children by their session id; the engine keeps them either way. */
  onClear: (ids: string[]) => void
  /** Child sessions the engine is working on right now. */
  running: string[]
  /** Child sessions waiting on a permission nobody has answered. */
  blocked: string[]
}

/**
 * The sessions this one has spawned, listed under Tasks in the right aside.
 *
 * They used to sit as chips across the top of the transcript, where they took a line from every
 * message and read as part of the conversation. They are a property of where you are — siblings of
 * this session — so they belong with the context, and they open the same way a session row does.
 *
 * The dot is the same one the sidebar draws: it is how a reader sees a subagent still working
 * without opening it, which a chip that only said its name could never do.
 *
 * The list is the engine's, so the two clear buttons only hide rows here — same as Tasks. A child
 * the engine is working on or one that waits on an answer is not "completed" and Clear all is the
 * only way to take it off the panel.
 */
export const SubagentList: Component<SubagentListProps> = (props) => {
  const sessions = () => props.sessions ?? []
  const busy = (id: string) => props.running.includes(id) || props.blocked.includes(id)
  const completed = () => sessions().filter((session) => !busy(session.id))

  return (
    <Show when={sessions().length > 0}>
      <section class="fc-aside-section">
        <h3 class="fc-aside-title">
          {t("Subagents")}
          <span class="fc-aside-title-actions">
            <Show when={completed().length > 0}>
              <button
                class="fc-aside-clear"
                type="button"
                aria-label={t("Clear completed subagents")}
                onClick={() => props.onClear(completed().map((session) => session.id))}
              >
                {t("Clear completed")}
              </button>
            </Show>
            <button
              class="fc-aside-clear"
              type="button"
              aria-label={t("Clear all subagents")}
              onClick={() => props.onClear(sessions().map((session) => session.id))}
            >
              {t("Clear all")}
            </button>
            <span class="fc-aside-count">
              {completed().length}/{sessions().length}
            </span>
          </span>
        </h3>
        <div class="fc-subagents-list">
          <For each={sessions()}>
            {(session) => (
              <button class="fc-subagent" type="button" onClick={() => props.onOpen(session.id)}>
                <span
                  class="fc-session-dot"
                  classList={{
                    "fc-session-dot-running": props.running.includes(session.id),
                    "fc-session-dot-blocked": props.blocked.includes(session.id),
                  }}
                  title={props.blocked.includes(session.id) ? t("Waiting for permission") : undefined}
                  aria-hidden="true"
                />
                <span class="fc-subagent-title">{session.title || session.id.slice(0, 8)}</span>
              </button>
            )}
          </For>
        </div>
      </section>
    </Show>
  )
}
