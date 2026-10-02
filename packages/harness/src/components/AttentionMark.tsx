import type { Component } from "solid-js"
import { t } from "../i18n"
import type { Attention } from "../attention"

/**
 * One word per level (UX-02), the app's own where it already had one: "Needs approval" is what a
 * web action that waits for a person says, "Needs your input" what a run whose agent asked says
 * (RP-06), "Failed" and "Not verified" are the verdict's words.
 */
const LABELS: Record<Attention, string> = {
  approval: "Needs approval",
  answer: "Needs your input",
  failed: "Failed",
  unverified: "Not verified",
  running: "Running",
  unseen: "Finished, not seen yet",
}

export const attentionLabel = (level: Attention) => t(LABELS[level])

/**
 * The attention indicator (UX-02): the same mark for a session, a run, a routine or a group of
 * them, everywhere the app shows one. Static, except "running", which is the one level that is
 * still moving. With `count` it is a small pill that says how many rows of a collapsed group are at
 * this level.
 */
export const AttentionMark: Component<{ level: Attention; count?: number }> = (props) => (
  <span
    class="fc-attention"
    classList={{ "fc-attention-count": props.count !== undefined }}
    data-attention={props.level}
    role="img"
    aria-label={
      props.count === undefined ? attentionLabel(props.level) : `${attentionLabel(props.level)} (${props.count})`
    }
    title={attentionLabel(props.level)}
  >
    {props.count}
  </span>
)
