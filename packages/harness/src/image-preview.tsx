import { Show, createSignal, type Component } from "solid-js"
import { t } from "./i18n"
import { Modal, ModalClose } from "./components/Modal"

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
  return (
    <Show when={image()}>
      {(preview) => (
        <Modal
          onClose={closeImagePreview}
          backdropClass="fc-modal-backdrop fc-image-preview-backdrop"
          class="fc-image-preview"
          label={preview().name ?? t("Image")}
        >
          <img class="fc-image-preview-image" src={preview().uri} alt={preview().name ?? t("Image")} />
          <ModalClose class="fc-icon-button fc-image-preview-close" />
        </Modal>
      )}
    </Show>
  )
}
