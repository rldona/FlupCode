import { For, Show, createEffect, createSignal, type Component } from "solid-js"
import type { MemoryInfo } from "@opencode-ai/sdk/v2/client"
import { createClient } from "../client"
import { memoryScopeLabel } from "../memory"
import { t } from "../i18n"

type MemoryInspectorProps = {
  serverUrl: string
  sessionID?: string
}

export const MemoryInspector: Component<MemoryInspectorProps> = (props) => {
  const [items, setItems] = createSignal<MemoryInfo[]>([])

  let generation = 0
  createEffect(() => {
    const sessionID = props.sessionID
    const serverUrl = props.serverUrl
    generation += 1
    const current = generation
    if (!sessionID) {
      setItems([])
      return
    }
    void createClient(serverUrl)
      .memory.used({ sessionID })
      .then((result) => {
        if (current === generation) setItems(result.data ?? [])
      })
      .catch(() => {
        if (current === generation) setItems([])
      })
  })

  return (
    <section class="fc-aside-section">
      <h3 class="fc-aside-title">
        {t("Memory")}
        <Show when={items().length > 0}>
          <span class="fc-aside-count">{items().length}</span>
        </Show>
      </h3>
      <Show when={items().length > 0} fallback={<div class="fc-empty">{t("No memories used")}</div>}>
        <ul class="fc-aside-memory">
          <For each={items()}>
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
