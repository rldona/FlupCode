import { For, type Component } from "solid-js"
import { t } from "../i18n"

export type SessionTab = { id: string; title?: string }

type SessionTabsProps = {
  tabs: SessionTab[]
  active?: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
}

/**
 * The sessions open in this window, as a strip (H-36).
 *
 * The selected session is the active tab, so switching one is selecting it: the sidebar, the top bar
 * and the context panel follow, exactly as they do when a session is chosen from the list. Closing a
 * tab is not deleting the session — it is closing the window's view of it.
 */
export const SessionTabs: Component<SessionTabsProps> = (props) => (
  <div class="fc-session-tabs" role="tablist" aria-label={t("Open sessions")}>
    <For each={props.tabs}>
      {(tab) => (
        <div class="fc-session-tab" classList={{ "fc-session-tab-active": tab.id === props.active }}>
          <button
            class="fc-session-tab-name"
            type="button"
            role="tab"
            aria-selected={tab.id === props.active}
            onClick={() => props.onSelect(tab.id)}
          >
            <bdi dir="auto">{tab.title || t("Untitled session")}</bdi>
          </button>
          <button
            class="fc-session-tab-close"
            type="button"
            aria-label={t("Close tab")}
            onClick={() => props.onClose(tab.id)}
          >
            ×
          </button>
        </div>
      )}
    </For>
  </div>
)
