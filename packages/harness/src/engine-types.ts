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
export type {
  Provider as ProviderDirectoryInfo,
  ProviderAuthMethod,
} from "@opencode-ai/sdk/v2/client"

export type {
  IntegrationAttempt,
  IntegrationAttemptStatus,
  IntegrationInfo,
  IntegrationOAuthMethod,
} from "@opencode-ai/sdk/v2/client"

export type McpServer = {
  name: string
  status: { status?: string } | unknown
}
