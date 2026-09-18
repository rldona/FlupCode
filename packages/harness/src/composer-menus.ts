/**
 * What the composer's `/` and `@` menus mean, in one place (H-26).
 *
 * The desktop and mobile composers were two copies, and the copy on the phone had neither menu. The
 * rules for when a menu opens and what it offers are not a matter of screen size, so they live here
 * and both call them; only the drawing differs.
 */

export type MentionItem = {
  kind: "file" | "agent" | "artifact"
  /** What goes after the `@`. */
  value: string
  /** What the row shows. */
  label: string
  /** The small line at the end: where it comes from. */
  hint?: string
}

export type MentionSources = {
  /** Files found by the engine for the current token. */
  files: Array<{ path: string; type?: string }>
  agents: Array<{ id: string; description?: string }>
  artifacts: Array<{ path: string; title?: string }>
}

/** The command query, or `undefined` when the draft is not a `/` command in progress. */
export function slashQuery(value: string, chat: boolean): string | undefined {
  if (chat || !value.startsWith("/")) return undefined
  const body = value.slice(1)
  if (body.includes(" ")) return undefined
  return body.toLowerCase()
}

export function filterCommands<T extends { name: string }>(commands: T[], query: string | undefined): T[] {
  if (query === undefined) return []
  return commands.filter((command) => command.name.toLowerCase().includes(query)).slice(0, 8)
}

/** The mention token, or `undefined` when the draft is not an `@` mention in progress. */
export function mentionToken(value: string, chat: boolean): string | undefined {
  if (chat) return undefined
  const at = value.lastIndexOf("@")
  if (at === -1) return undefined
  const token = value.slice(at + 1)
  if (token.includes(" ")) return undefined
  return token
}

/**
 * What the `@` menu offers: files first, then agents, then artifacts, all filtered by the token.
 *
 * Agents are how a turn is aimed and artifacts are things the session already produced, so they are
 * worth reaching without leaving the draft. Capped so the menu stays a menu.
 */
export function mentionItems(token: string, sources: MentionSources): MentionItem[] {
  const needle = token.trim().toLowerCase()
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle)
  const items: MentionItem[] = [
    ...sources.files
      .filter((file) => matches(file.path))
      .map((file) => ({ kind: "file" as const, value: file.path, label: `@${file.path}`, hint: file.type })),
    ...sources.agents
      .filter((agent) => matches(agent.id))
      .map((agent) => ({ kind: "agent" as const, value: agent.id, label: `@${agent.id}`, hint: "agent" })),
    ...sources.artifacts
      .filter((artifact) => matches(artifact.path))
      .map((artifact) => ({
        kind: "artifact" as const,
        value: artifact.path,
        label: `@${artifact.path}`,
        hint: artifact.title ?? "artifact",
      })),
  ]
  return items.slice(0, 8)
}

/** The draft with the mention picked, replacing the half-typed token. */
export function applyMention(value: string, item: MentionItem): string {
  const at = value.lastIndexOf("@")
  if (at === -1) return value
  const before = value.slice(0, at)
  const after = value.slice(at + 1)
  const rest = after.includes(" ") ? after.slice(after.indexOf(" ")) : ""
  return `${before}@${item.value} ${rest.trimStart()}`.trimEnd() + " "
}
