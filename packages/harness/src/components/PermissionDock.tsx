import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import type { PermissionV2Request, SessionMessageInfo } from "../engine-types"
import { t } from "../i18n"
import { alwaysScope, permissionPreview } from "../permission-preview"
import { diffLines, highlight, highlightDiff } from "../highlight"

export type PermissionReply = "once" | "always" | "reject"

type PermissionDockProps = {
  request: PermissionV2Request
  /** The open transcript, which holds the tool call the request came from; see permission-preview. */
  messages: SessionMessageInfo[] | undefined
  busy: boolean
  onReply: (reply: PermissionReply, message?: string) => void
}

const languageFor = (path: string) => path.split(".").pop() ?? ""

export const PermissionDock: Component<PermissionDockProps> = (props) => {
  const [rejecting, setRejecting] = createSignal(false)
  const [reason, setReason] = createSignal("")
  const preview = createMemo(() => permissionPreview(props.request, props.messages))
  const scope = () => alwaysScope(props.request)

  return (
    <div class="fc-dock fc-dock-permission">
      <div class="fc-dock-header">
        <span class="fc-dock-title">{t("Permission required")}</span>
        <span class="fc-chip">{props.request.action}</span>
      </div>

      <Show when={preview().kind === "command" && preview()} keyed>
        {(value) => (
          <pre
            class="fc-code fc-permission-preview"
            innerHTML={highlight((value as { command: string }).command, "bash")}
          />
        )}
      </Show>

      <Show when={preview().kind === "edit" && preview()} keyed>
        {(value) => {
          const edit = value as { path: string; before: string; after: string }
          const unified = diffLines(edit.before, edit.after)
            .map((line) => `${line.type === "add" ? "+" : line.type === "del" ? "-" : " "}${line.text}`)
            .join("\n")
          return (
            <div class="fc-permission-preview">
              <span class="fc-permission-path">{edit.path}</span>
              <pre class="fc-diff-view" innerHTML={highlightDiff(unified)} />
            </div>
          )
        }}
      </Show>

      <Show when={preview().kind === "write" && preview()} keyed>
        {(value) => {
          const write = value as { path: string; content: string }
          return (
            <div class="fc-permission-preview">
              <span class="fc-permission-path">{write.path}</span>
              <pre class="fc-code" innerHTML={highlight(write.content, languageFor(write.path))} />
            </div>
          )
        }}
      </Show>

      <Show when={preview().kind === "url" && preview()} keyed>
        {(value) => <code class="fc-permission-preview">{(value as { url: string }).url}</code>}
      </Show>

      <Show when={preview().kind === "resources" && props.request.resources.length > 0}>
        <ul class="fc-dock-list">
          <For each={props.request.resources}>
            {(resource) => (
              <li>
                <code>{resource}</code>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={rejecting()}>
        <input
          class="fc-filter-input fc-permission-reason"
          placeholder={t("Why? The agent reads this (optional)")}
          aria-label={t("Why? The agent reads this (optional)")}
          value={reason()}
          autofocus
          onInput={(event) => setReason(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") props.onReply("reject", reason().trim() || undefined)
            if (event.key === "Escape") setRejecting(false)
          }}
        />
      </Show>

      <div class="fc-dock-actions">
        <button
          class="fc-button fc-button-primary"
          type="button"
          disabled={props.busy}
          onClick={() => props.onReply("once")}
        >
          {t("Allow once")}
        </button>
        <button
          class="fc-button"
          type="button"
          disabled={props.busy}
          title={scope() ? t("Remembers: {patterns}", { patterns: scope()!.patterns.join(", ") }) : undefined}
          onClick={() => props.onReply("always")}
        >
          {t("Allow always")}
          {/* An edit saves `*`, so "always" is the whole project rather than this file. Say which. */}
          <Show when={scope()}>
            {(value) => (
              <span class="fc-permission-scope">
                {value().wide ? t("every {action}", { action: props.request.action }) : value().patterns.join(", ")}
              </span>
            )}
          </Show>
        </button>
        <Show
          when={rejecting()}
          fallback={
            <button
              class="fc-button fc-button-danger"
              type="button"
              disabled={props.busy}
              onClick={() => setRejecting(true)}
            >
              {t("Reject")}
            </button>
          }
        >
          <button
            class="fc-button fc-button-danger"
            type="button"
            disabled={props.busy}
            onClick={() => props.onReply("reject", reason().trim() || undefined)}
          >
            {reason().trim() ? t("Reject with reason") : t("Reject")}
          </button>
        </Show>
      </div>
    </div>
  )
}
