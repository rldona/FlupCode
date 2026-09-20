export type Attachment = {
  uri: string
  name: string
}

export type CommandOption = {
  name: string
  description?: string
}

export type McpConfig = { type: "local"; command: string[] } | { type: "remote"; url: string }
