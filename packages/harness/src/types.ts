export type Attachment = {
  uri: string
  name: string
}

export type CommandOption = {
  name: string
  description?: string
}

export type McpConfig = { type: "local"; command: string[] } | { type: "remote"; url: string }

export type StashedPrompt = {
  id: string
  text: string
  createdAt: number
}

export type Routine = {
  id: string
  name: string
  prompt: string
  intervalMinutes: number
  enabled: boolean
  createdAt: number
  lastRunAt?: number
}

export type SessionTags = Record<string, string[]>
