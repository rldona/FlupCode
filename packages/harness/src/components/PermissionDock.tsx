import { For, Show, type Component } from "solid-js"
import type { PermissionV2Request } from "@opencode-ai/client"

export type PermissionReply = "once" | "always" | "reject"

type PermissionDockProps = {
  request: PermissionV2Request
  busy: boolean
  onReply: (reply: PermissionReply) => void
}

export const PermissionDock: Component<PermissionDockProps> = (props) => (
  <div class="oh-dock oh-dock-permission">
    <div class="oh-dock-header">
      <span class="oh-dock-title">Permiso requerido</span>
      <span class="oh-chip">{props.request.action}</span>
    </div>
    <Show when={props.request.resources.length > 0}>
      <ul class="oh-dock-list">
        <For each={props.request.resources}>{(resource) => <li><code>{resource}</code></li>}</For>
      </ul>
    </Show>
    <div class="oh-dock-actions">
      <button class="oh-button oh-button-primary" type="button" disabled={props.busy} onClick={() => props.onReply("once")}>
        Permitir una vez
      </button>
      <button class="oh-button" type="button" disabled={props.busy} onClick={() => props.onReply("always")}>
        Permitir siempre
      </button>
      <button
        class="oh-button oh-button-danger"
        type="button"
        disabled={props.busy}
        onClick={() => props.onReply("reject")}
      >
        Rechazar
      </button>
    </div>
  </div>
)
