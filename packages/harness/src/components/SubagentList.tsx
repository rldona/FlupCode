import { For, Show, type Component } from "solid-js"
import type { SessionInfo } from "../engine-types"
import { t } from "../i18n"

type SubagentListProps = {
  sessions: SessionInfo[] | undefined
  onOpen: (id: string) => void
}

/**
 * The sessions this one has spawned, listed under Tasks in the right aside.
 *
 * They used to sit as chips across the top of the transcript, where they took a line from every
 * message and read as part of the conversation. They are a property of where you are — siblings of
 * this session — so they belong with the context, and they open the same way a session row does.
 */
export const SubagentList: Component<SubagentListProps> = (props) => (
  <Show when={props.sessions && props.sessions.length > 0}>
    <section class="fc-aside-section">
      <h3 class="fc-aside-title">{t("Subagents")}</h3>
      <div class="fc-subagents-list">
        <For each={props.sessions}>
          {(session) => (
            <button class="fc-subagent" type="button" onClick={() => props.onOpen(session.id)}>
              {session.title || session.id.slice(0, 8)}
            </button>
          )}
        </For>
      </div>
    </section>
  </Show>
)
