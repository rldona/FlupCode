import type { Engine } from "./engine"

/**
 * The plan's hand-off to build on OpenCode 2 (V2-33), what 1.x's patched engine did in its own
 * `plan_exit` tool: ask the reader in the session whether to switch to the build agent and start
 * implementing, and switch it when they say yes, so the next step of the run executes the plan.
 */
export async function planExit(engine: Pick<Engine, "askChoice" | "switchAgent">, sessionID: string) {
  const choice = await engine.askChoice({
    sessionID,
    title: "Build agent",
    description: "The plan is complete. Would you like to switch to the build agent and start implementing?",
    options: [
      { value: "yes", label: "Yes", description: "Switch to build agent and start implementing the plan" },
      { value: "no", label: "No", description: "Stay with plan agent to continue refining the plan" },
    ],
    timeoutMs: 30 * 60 * 1000,
  })
  if (choice !== "yes") return { approved: false }
  await engine.switchAgent(sessionID, "build")
  return { approved: true }
}
