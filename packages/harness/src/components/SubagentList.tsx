import { For, Show, type Component } from "solid-js"
import type { SessionInfo } from "../engine-types"
import { t } from "../i18n"

type SubagentListProps = {
  sessions: SessionInfo[] | undefined
  onOpen: (id: string) => void
}

export const SubagentList: Component<SubagentListProps> = (props) => (
  <Show when={props.sessions && props.sessions.length > 0}>
    <div class="fc-subagents">
      <span class="fc-section-label">{t("Subagents")}</span>
      <div class="fc-subagents-list">
        <For each={props.sessions}>
          {(session) => (
            <button class="fc-subagent" type="button" onClick={() => props.onOpen(session.id)}>
              {session.title || session.id.slice(0, 8)}
            </button>
          )}
        </For>
      </div>
    </div>
  </Show>
)
