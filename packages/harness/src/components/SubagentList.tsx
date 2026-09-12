import { For, Show, type Component } from "solid-js"
import type { SessionInfo } from "@opencode-ai/client"

type SubagentListProps = {
  sessions: SessionInfo[] | undefined
  onOpen: (id: string) => void
}

export const SubagentList: Component<SubagentListProps> = (props) => (
  <Show when={props.sessions && props.sessions.length > 0}>
    <div class="oh-subagents">
      <span class="oh-section-label">Subagentes</span>
      <div class="oh-subagents-list">
        <For each={props.sessions}>
          {(session) => (
            <button class="oh-subagent" type="button" onClick={() => props.onOpen(session.id)}>
              {session.title || session.id.slice(0, 8)}
            </button>
          )}
        </For>
      </div>
    </div>
  </Show>
)
