import { Show, createEffect, createSignal, onCleanup, type Component } from "solid-js"
import { t } from "./i18n"

type PreviewImage = { uri: string; name?: string }

const [image, setImage] = createSignal<PreviewImage>()

/** Opens a prompt image alone in a modal; the transcript thumbnail calls it. */
export function openImagePreview(next: PreviewImage) {
  setImage(next)
}

export function closeImagePreview() {
  setImage(undefined)
}

export const ImagePreview: Component = () => {
  createEffect(() => {
    if (!image()) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeImagePreview()
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  return (
    <Show when={image()}>
      {(preview) => (
        <div class="fc-modal-backdrop fc-image-preview-backdrop" onClick={closeImagePreview}>
          <div
            class="fc-image-preview"
            role="dialog"
            aria-modal="true"
            aria-label={preview().name ?? t("Image")}
            onClick={(event) => event.stopPropagation()}
          >
            <img class="fc-image-preview-image" src={preview().uri} alt={preview().name ?? t("Image")} />
            <button
              class="fc-icon-button fc-image-preview-close"
              type="button"
              aria-label={t("Close")}
              onClick={closeImagePreview}
            >
              ×
            </button>
          </div>
        </div>
      )}
    </Show>
  )
}
