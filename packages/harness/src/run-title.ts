import { t } from "./i18n"
import type { Run } from "./types"

/**
 * What a run is called (RP-01): the workflow it executed, when one did; otherwise who asked for it,
 * by the routine's own name when it is known (UX-04). A routine that runs a workflow is named after
 * the workflow, which is what it did.
 */
export const runTitle = (run: Run, routineName?: string) =>
  run.workflow?.name ?? (run.source.type === "routine" ? (routineName ?? t("Routine")) : t("Manual run"))

/** The inputs a workflow run was given, as `name: value`, or nothing. */
export const runInputs = (run: Run) =>
  Object.entries(run.workflow?.inputs ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join(" · ") || undefined
