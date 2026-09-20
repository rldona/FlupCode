import type { AgentFile } from "./types"

/**
 * Which agents see a skill (SK-1).
 *
 * The same rule the engine applies to the `tools` map it reads from agent files, as `mcp-access`
 * does for servers: `{"skill": true}` allows all, `{"skill_<name>": true}` allows one, `"*"` is
 * everything. Read here so the catalogue can say who loads a skill without opening every agent
 * file by hand.
 */

/** Whether a tools map allows a skill, by the skill key, its prefixed key, or the wildcard. */
export function agentAllowsSkill(name: string, tools: Record<string, unknown> | undefined) {
  if (!tools) return false
  if (tools["*"] === true) return true
  if (tools["skill"] === true) return true
  return tools[`skill_${name}`] === true
}

export type SkillAccess = {
  skill: string
  /** The agents whose files allow it, by name, in the order the files were listed. */
  agents: string[]
}

export function skillAccess(skills: string[], agents: AgentFile[]): SkillAccess[] {
  return skills.map((skill) => ({
    skill,
    agents: agents
      .filter((agent) => {
        const tools = agent.fields.tools
        return !!tools && typeof tools === "object" && agentAllowsSkill(skill, tools as Record<string, unknown>)
      })
      .map((agent) => agent.name),
  }))
}
