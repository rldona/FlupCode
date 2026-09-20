import type { AgentInfo } from "./engine-types"

/** The order the dock's agent picker shows before falling back to the engine's order. */
const PRIMARY_AGENT_ORDER = ["plan", "build"]

/** Primary, visible agents for the dock, with Plan ahead of Build. */
export function primaryAgents(agents: AgentInfo[]) {
  return agents
    .filter((agent) => agent.mode === "primary" && !agent.hidden)
    .sort((a, b) => rankAgent(a) - rankAgent(b))
}

function rankAgent(agent: AgentInfo) {
  const index = PRIMARY_AGENT_ORDER.indexOf(agent.id)
  return index === -1 ? PRIMARY_AGENT_ORDER.length : index
}
