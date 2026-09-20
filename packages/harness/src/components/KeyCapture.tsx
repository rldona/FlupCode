import { createSignal, type Component } from "solid-js"
import { t } from "../i18n"

type KeyCaptureProps = {
  value: string
  onChange: (value: string) => void
}

const MODIFIERS = ["control", "meta", "shift", "alt"]

export const KeyCapture: Component<KeyCaptureProps> = (props) => {
  const [capturing, setCapturing] = createSignal(false)

  const capture = (event: KeyboardEvent) => {
    if (!capturing()) return
    event.preventDefault()
    event.stopPropagation()
    const key = event.key.toLowerCase()
    if (MODIFIERS.includes(key)) return
    const parts: string[] = []
    if (event.metaKey || event.ctrlKey) parts.push("mod")
    if (event.shiftKey) parts.push("shift")
    if (event.altKey) parts.push("alt")
    parts.push(key)
    props.onChange(parts.join("+"))
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
      {capturing() ? t("Press keys…") : props.value}
    </button>
  )
}
