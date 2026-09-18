import type { ModelV2Info, SessionMessagesResponse as SdkSessionMessagesResponse } from "@opencode-ai/sdk/v2/client"

export type {
  AgentV2Info as AgentInfo,
  FileSystemEntry,
  ModelV2Info as ModelInfo,
  PermissionV2Request,
  ProviderV2Info as ProviderInfo,
  QuestionV2Request,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionV2Info as SessionInfo,
  SkillV2Info as SkillInfo,
} from "@opencode-ai/sdk/v2/client"

export type ModelVariant = ModelV2Info["variants"][number]
export type SessionMessagesResponse = SdkSessionMessagesResponse
export type SessionMessageInfo = SdkSessionMessagesResponse["data"][number]

export type { SnapshotFileDiff as FileDiffInfo } from "@opencode-ai/sdk/v2/client"
export type { Provider as ProviderDirectoryInfo, ProviderAuthMethod } from "@opencode-ai/sdk/v2/client"

export type {
  IntegrationAttempt,
  IntegrationAttemptStatus,
  IntegrationInfo,
  IntegrationOAuthMethod,
} from "@opencode-ai/sdk/v2/client"

export type McpServer = {
  name: string
  /** The engine's status object: a `status` and, when it failed, the reason (H-34). */
  status: { status?: string; error?: string } | unknown
}

/** A resource an MCP server exposes (H-34), as the engine reports it. */
export type McpResource = {
  name: string
  uri: string
  description?: string
  mimeType?: string
  /** The server it belongs to. */
  client: string
}
