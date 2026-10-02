import type { Component } from "solid-js"
import { stateLabel, type RunState } from "../run-state"

/**
 * Where a run or a task stands, in one word (UX-04): its verdict once it has ended (RP-06), its
 * status while it goes. `unverified` is drawn as an outline, never as a quieter `verified`: a clean
 * answer nothing checked must not read as checked work (P4). The reason is the tooltip; where there
 * is room the caller shows it as text too.
 */
export const StateBadge: Component<{ state: RunState; reason?: string }> = (props) => (
  <span class="fc-verdict" data-verdict={props.state} title={props.reason}>
    {stateLabel(props.state)}
  </span>
)
