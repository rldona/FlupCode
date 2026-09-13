/**
 * Conversations (chats) next to code sessions, like Claude's Chat / Code tabs.
 *
 * The engine has no chat concept: a chat is a session in the engine's own state folder (from
 * `GET /path`, so every client of that engine sees the same chats), with every tool denied except
 * the web ones, prompted through the legacy endpoint because only it accepts a system prompt.
 */

export type AppView = "code" | "chat"

/** Chats can talk and read the web, nothing on the user's computer. Later rules win. */
export const CHAT_PERMISSION: Array<{ permission: string; pattern: string; action: "allow" | "deny" }> = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "webfetch", pattern: "*", action: "allow" },
  { permission: "websearch", pattern: "*", action: "allow" },
]

export const CHAT_SYSTEM = [
  "You are in chat mode: a friendly, helpful conversational assistant.",
  "This is a conversation, not a coding task. There is no project folder, and you cannot read, write or run anything on the user's computer.",
  "When it helps, you can search and read the web.",
  "Answer in the user's language, conversationally, with clear formatting.",
].join("\n")

export function isChatSession(session: { location?: { directory?: string } }, chatsDirectory: string | undefined) {
  return !!chatsDirectory && session.location?.directory === chatsDirectory
}

/** The home greeting for the time of day, as an i18n key and its params. */
export function chatGreeting(name: string, hour: number) {
  const trimmed = name.trim()
  const part = hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 20 ? "afternoon" : "evening"
  const key = { morning: "Good morning", afternoon: "Good afternoon", evening: "Good evening" }[part]
  return trimmed ? { key: `${key}, {name}`, params: { name: trimmed } } : { key, params: undefined }
}

/** Starters under the empty chat input; each fills the input with the beginning of a prompt. */
export const CHAT_STARTERS = [
  { id: "write", label: "Write", prompt: "Help me write " },
  { id: "learn", label: "Learn", prompt: "Explain to me " },
  { id: "ideas", label: "Brainstorm", prompt: "Give me ideas for " },
  { id: "web", label: "Search the web", prompt: "Search the web for " },
] as const

/** Attachments as legacy file parts: data URIs carry their mime type. */
export function chatFileParts(files: Array<{ uri: string; name?: string }>) {
  return files.map((file) => ({
    type: "file" as const,
    mime: /^data:([^;,]+)/.exec(file.uri)?.[1] ?? "application/octet-stream",
    url: file.uri,
    ...(file.name ? { filename: file.name } : {}),
  }))
}
