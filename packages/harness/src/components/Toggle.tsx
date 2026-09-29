import { type Component } from "solid-js"

/** A clear on/off switch: the knob's side and colour say the state, not a word to read. */
export const Toggle: Component<{ checked: boolean; label: string; disabled?: boolean; onToggle: () => void }> = (
  props,
) => (
  <button
    class="fc-switch"
    role="switch"
    type="button"
    aria-checked={props.checked}
    aria-label={props.label}
    aria-disabled={props.disabled === true}
    disabled={props.disabled === true}
    onClick={props.onToggle}
  >
    <span class="fc-switch-knob" aria-hidden="true" />
  </button>
)
