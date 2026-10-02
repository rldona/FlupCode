/** Test support for BU-01: a real action runner whose runs arrive already approved. */

import { createActionRunner } from "./action-runner"
import type { ActionRunnerOptions, ActionRunRequest } from "./action-runner"
import { createBrowserPolicy } from "./browser-policy"
import type { SqliteRoutineRepository } from "./repository"

/**
 * The runner as production builds it, with each run carrying the permit a person's "Allow once"
 * gives. Tests of the recipe itself use it; what precedes a run (the policy and the approval) has
 * tests of its own.
 */
export function approvedRunner(
  options: Omit<ActionRunnerOptions, "policy" | "repository"> & { repository: SqliteRoutineRepository },
) {
  const policy = createBrowserPolicy(options.repository)
  const runner = createActionRunner({ ...options, policy })
  const originFor = (input: ActionRunRequest) => {
    const profile = input.profile ?? options.loadProfiles(input).profiles[input.action ?? ""]
    const origin = profile && typeof profile === "object" && "origin" in profile ? profile.origin : undefined
    return typeof origin === "string" ? origin : ""
  }
  return {
    ...runner,
    run: (input: ActionRunRequest) =>
      runner.run({
        ...input,
        permit: input.permit ?? policy.answer({ origin: originFor(input), tier: "sensitive" }, "once"),
      }),
  }
}
