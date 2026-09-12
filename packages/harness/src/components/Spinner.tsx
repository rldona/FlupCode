import type { Component } from "solid-js"

export const Spinner: Component<{ class?: string }> = (props) => (
  <svg class={`fc-spinner ${props.class ?? ""}`} viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <g stroke="var(--fc-accent)" stroke-width="2.4" stroke-linecap="round">
      <line x1="12" y1="2.5" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="21.5" />
      <line x1="2.5" y1="12" x2="6" y2="12" />
      <line x1="18" y1="12" x2="21.5" y2="12" />
      <line x1="5.3" y1="5.3" x2="7.8" y2="7.8" />
      <line x1="16.2" y1="16.2" x2="18.7" y2="18.7" />
      <line x1="5.3" y1="18.7" x2="7.8" y2="16.2" />
      <line x1="16.2" y1="7.8" x2="18.7" y2="5.3" />
    </g>
  </svg>
)
