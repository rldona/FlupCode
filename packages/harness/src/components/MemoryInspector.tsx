import { For, Show, type Component } from "solid-js"
import type { MemoryInfo } from "../engine-types"
import { memoryScopeLabel } from "../memory"
import { t } from "../i18n"

type MemoryInspectorProps = {
  /** The memories the engine retrieved for the open session. */
  items: MemoryInfo[]
}

export const MemoryInspector: Component<MemoryInspectorProps> = (props) => {
  return (
    <section class="fc-aside-section">
      <h3 class="fc-aside-title">
        {t("Memory")}
        <Show when={props.items.length > 0}>
          <span class="fc-aside-count">{props.items.length}</span>
        </Show>
      </h3>
      <Show when={props.items.length > 0} fallback={<div class="fc-empty">{t("No memories used")}</div>}>
        <ul class="fc-aside-memory">
          <For each={props.items}>
            {(memory) => (
              <li class="fc-aside-memory-item" title={memory.content}>
                <span class={`fc-memory-scope fc-memory-scope-${memory.scope}`}>{memoryScopeLabel(memory.scope)}</span>
                <span class="fc-aside-memory-title">{memory.title}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}
