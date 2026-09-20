import type { Component } from "solid-js"

export const Mascot: Component<{ class?: string }> = (props) => (
  <svg class={props.class} viewBox="0 0 34 22" width="34" height="22" aria-hidden="true">
    <rect x="6" y="4" width="22" height="11" rx="1.5" fill="var(--fc-accent)" />
    <rect x="11" y="8" width="3" height="3" fill="#241812" />
    <rect x="20" y="8" width="3" height="3" fill="#241812" />
    <rect x="8" y="15" width="2" height="5" fill="var(--fc-accent)" />
    <rect x="13" y="15" width="2" height="5" fill="var(--fc-accent)" />
    <rect x="19" y="15" width="2" height="5" fill="var(--fc-accent)" />
    <rect x="24" y="15" width="2" height="5" fill="var(--fc-accent)" />
  </svg>
)
