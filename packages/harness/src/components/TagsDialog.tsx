import { For, Show, createEffect, createSignal, on, type Component } from "solid-js"
import { t } from "../i18n"

type TagsDialogProps = {
  open: boolean
  title: string
  initial: string[]
  onSave: (tags: string[]) => void
  onClose: () => void
}

/** Split on commas or newlines, trimmed, in order, without repeats. */
export function parseTags(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map((tag) => tag.trim()).filter(Boolean))]
}

/**
 * Edits a session's tags (H-18).
 *
 * One field, because tags are quick to type and there are rarely many: a list of inputs with an add
 * button is more chrome than the thing it edits. Saving with nothing clears them.
 */
export const TagsDialog: Component<TagsDialogProps> = (props) => {
  const [value, setValue] = createSignal("")
  let input: HTMLInputElement | undefined

  createEffect(
    on(
      () => [props.open, props.initial] as const,
      ([open, initial]) => {
        if (!open) return
        setValue(initial.join(", "))
        queueMicrotask(() => {
          input?.focus()
          input?.select()
        })
      },
    ),
  )

  const parsed = () => parseTags(value())
  const save = () => props.onSave(parsed())

  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div
          class="fc-modal"
          role="dialog"
          aria-modal="true"
          aria-label={props.title}
          onClick={(event) => event.stopPropagation()}
        >
          <div class="fc-modal-header">
            <span>{props.title}</span>
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
              ×
            </button>
          </div>
          <input
            ref={input}
            class="fc-question-custom fc-rename-input"
            value={value()}
            placeholder={t("Tags, separated by commas")}
            aria-label={t("Tags")}
            spellcheck={false}
            onInput={(event) => setValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                save()
                return
              }
              if (event.key === "Escape") {
                event.preventDefault()
                props.onClose()
              }
            }}
          />
          <Show when={parsed().length > 0}>
            <div class="fc-tag-preview">
              <For each={parsed()}>{(tag) => <span class="fc-session-tag">{tag}</span>}</For>
            </div>
          </Show>
          <div class="fc-dialog-actions">
            <button class="fc-button" type="button" onClick={props.onClose}>
              {t("Cancel")}
            </button>
            <button class="fc-button fc-button-primary" type="button" onClick={save}>
              {t("Save")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
