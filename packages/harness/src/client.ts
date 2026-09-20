import { OpenCode } from "@opencode-ai/client"

const DEFAULT_SERVER_URL = "http://localhost:4096"

export function resolveServerUrl() {
  const configured = import.meta.env.VITE_OPENCODE_SERVER_URL
  if (typeof configured === "string" && configured.length > 0) return configured
  return DEFAULT_SERVER_URL
}

export function createClient(baseUrl = resolveServerUrl()) {
  return OpenCode.make({ baseUrl })
}

export type HarnessClient = ReturnType<typeof createClient>
