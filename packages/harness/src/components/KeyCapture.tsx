import { createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { formatKeybind, keybindFromEvent } from "../keybinds"

type KeyCaptureProps = {
  value: string
  onChange: (value: string) => void
}

/**
 * Records the next key combination (H-24).
 *
 * A bare modifier is not a binding, so it waits for the real key; Escape leaves capture without
 * changing anything, which is what a reader who opened it by accident expects.
 */
export const KeyCapture: Component<KeyCaptureProps> = (props) => {
  const [capturing, setCapturing] = createSignal(false)

  const capture = (event: KeyboardEvent) => {
    if (!capturing()) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === "Escape") {
      setCapturing(false)
      return
    }
    const binding = keybindFromEvent(event)
    if (!binding) return
    props.onChange(binding)
    setCapturing(false)
  }

  return (
    <button
      class="fc-keycap"
      classList={{ "fc-keycap-capturing": capturing() }}
      type="button"
      onClick={(event) => {
        setCapturing(true)
        event.currentTarget.focus()
      }}
      onBlur={() => setCapturing(false)}
      onKeyDown={capture}
    >
      {capturing() ? t("Press keys…") : formatKeybind(props.value) || t("Unbound")}
    </button>
  )
}
