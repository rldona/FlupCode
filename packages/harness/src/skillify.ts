/**
 * Turning a session into a skill (H-43).
 *
 * A skill is a file the engine reads — `SKILL.md`, with a `name` in its frontmatter (H-27) — and the
 * session that did the work is the one that knows it. So the ask goes **there**, in the open
 * session, instead of to a hidden session reading a transcript: one visible turn, the agent writes
 * the file with its own tools, and the Skills screen reads it like any other. No extraction service,
 * no index: the procedure was in the conversation and the conversation is where it is written from.
 *
 * Whether the session was successful is the reader's call — they are the one invoking it — and the
 * prompt asks for what mattered rather than for a summary of everything.
 */

/** Where a project skill lives. The path the Skill Manager reads, so the file it writes shows up. */
export const SKILLS_DIRECTORY = ".opencode/skills"

export function skillifyPrompt() {
  return [
    "Turn what we just did into a reusable skill for this project.",
    `Write it to ${SKILLS_DIRECTORY}/<short-name>/SKILL.md, with YAML frontmatter:`,
    "---",
    "name: <short-name>",
    "description: <one line: when to use it>",
    "---",
    "",
    "Then the body: the procedure, the commands and files that mattered, and the pitfalls we hit —",
    "what somebody would need to repeat this task without reading this conversation.",
    "Use the write tool. Do not change anything else in the project.",
  ].join("\n")
}
