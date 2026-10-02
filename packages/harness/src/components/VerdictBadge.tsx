import type { Component } from "solid-js"
import { t } from "../i18n"
import type { TaskVerdict, VerdictValue } from "../types"

/** One word per verdict (RP-06), reusing the app's own where it has one ("Needs your input"). */
const LABELS: Record<VerdictValue, string> = {
  verified: "Verified",
  unverified: "Not verified",
  "needs-user": "Needs your input",
  failed: "Failed",
}

/**
 * A task's or a run's verdict (RP-06). `unverified` is drawn as an outline, never as a quieter
 * `verified`: a clean answer nothing checked must not read as checked work (P4). The reason is the
 * tooltip; where there is room the caller shows it as text too.
 */
export const VerdictBadge: Component<{ verdict: TaskVerdict }> = (props) => (
  <span class="fc-verdict" data-verdict={props.verdict.value} title={props.verdict.reason}>
    {t(LABELS[props.verdict.value])}
  </span>
)
