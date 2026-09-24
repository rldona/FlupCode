import { type Component } from "solid-js"

/** A clear on/off switch: the knob's side and colour say the state, not a word to read. */
export const Toggle: Component<{ checked: boolean; label: string; onToggle: () => void }> = (props) => (
  <button
    class="fc-switch"
    role="switch"
    type="button"
    aria-checked={props.checked}
    aria-label={props.label}
    onClick={props.onToggle}
  >
    <span class="fc-switch-knob" aria-hidden="true" />
  </button>
)
