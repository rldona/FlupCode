/**
 * The shapes of the engine's data the app is written against, frozen from the generated types of the
 * OpenCode 1.x SDK (`@opencode-ai/sdk/v2`) when FlupCode stopped vendoring it (ADR-0027, V2-71).
 *
 * They are FlupCode's own now: the OpenCode 2 adapter (`v2.ts`, `v2-convert.ts`) translates what
 * `@opencode/client` answers into them, so a pin bump changes the adapter, never the app. Edit them
 * as the app's model, not to follow upstream.
 */

export type OAuth = {
  type: "oauth"
  refresh: string
  access: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
}

export type SnapshotFileDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

export type PermissionAction = "allow" | "deny" | "ask"

export type PermissionRule = {
  permission: string
  pattern: string
  action: PermissionAction
}

export type PermissionRuleset = Array<PermissionRule>

export type Session = {
  id: string
  slug: string
  projectID: string
  workspaceID?: string
  directory: string
  path?: string
  parentID?: string
  summary?: {
    additions: number
    deletions: number
    files: number
    diffs?: Array<SnapshotFileDiff>
  }
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  share?: {
    url: string
  }
  title: string
  agent?: string
  model?: {
    id: string
    providerID: string
    variant?: string
  }
  version: string
  metadata?: {
    [key: string]: unknown
  }
  time: {
    created: number
    updated: number
    compacting?: number
    archived?: number
  }
  permission?: PermissionRuleset
  revert?: {
    messageID: string
    partID?: string
    snapshot?: string
    diff?: string
  }
}

export type OutputFormatText = {
  type: "text"
}

export type JsonSchema = {
  [key: string]: unknown
}

export type OutputFormatJsonSchema = {
  type: "json_schema"
  schema: JsonSchema
  retryCount?: number
}

export type OutputFormat = OutputFormatText | OutputFormatJsonSchema

export type UserMessage = {
  id: string
  sessionID: string
  role: "user"
  time: {
    created: number
  }
  format?: OutputFormat
  summary?: {
    title?: string
    body?: string
    diffs: Array<SnapshotFileDiff>
  }
  agent: string
  model: {
    providerID: string
    modelID: string
    variant?: string
  }
  system?: string
  tools?: {
    [key: string]: boolean
  }
}

export type ProviderAuthError = {
  name: "ProviderAuthError"
  data: {
    providerID: string
    message: string
  }
}

export type UnknownError = {
  name: "UnknownError"
  data: {
    message: string
    ref?: string
  }
}

export type MessageOutputLengthError = {
  name: "MessageOutputLengthError"
  data: {
    [key: string]: unknown
  }
}

export type MessageAbortedError = {
  name: "MessageAbortedError"
  data: {
    message: string
  }
}

export type StructuredOutputError = {
  name: "StructuredOutputError"
  data: {
    message: string
    retries: number
  }
}

export type ContextOverflowError = {
  name: "ContextOverflowError"
  data: {
    message: string
    responseBody?: string
  }
}

export type ContentFilterError = {
  name: "ContentFilterError"
  data: {
    message: string
  }
}

export type ApiError = {
  name: "APIError"
  data: {
    message: string
    statusCode?: number
    isRetryable: boolean
    responseHeaders?: {
      [key: string]: string
    }
    responseBody?: string
    metadata?: {
      [key: string]: string
    }
  }
}

export type AssistantMessage = {
  id: string
  sessionID: string
  role: "assistant"
  time: {
    created: number
    completed?: number
  }
  error?:
    | ProviderAuthError
    | UnknownError
    | MessageOutputLengthError
    | MessageAbortedError
    | StructuredOutputError
    | ContextOverflowError
    | ContentFilterError
    | ApiError
  parentID: string
  modelID: string
  providerID: string
  mode: string
  agent: string
  path: {
    cwd: string
    root: string
  }
  summary?: boolean
  cost: number
  tokens: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  structured?: unknown
  variant?: string
  finish?: string
}

export type Message = UserMessage | AssistantMessage

export type TextPart = {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  time?: {
    start: number
    end?: number
  }
  metadata?: {
    [key: string]: unknown
  }
}

export type SubtaskPart = {
  id: string
  sessionID: string
  messageID: string
  type: "subtask"
  prompt: string
  description: string
  agent: string
  model?: {
    providerID: string
    modelID: string
  }
  command?: string
}

export type ReasoningPart = {
  id: string
  sessionID: string
  messageID: string
  type: "reasoning"
  text: string
  metadata?: {
    [key: string]: unknown
  }
  time: {
    start: number
    end?: number
  }
}

export type FilePartSourceText = {
  value: string
  start: number
  end: number
}

export type FileSource = {
  text: FilePartSourceText
  type: "file"
  path: string
}

export type Range = {
  start: {
    line: number
    character: number
  }
  end: {
    line: number
    character: number
  }
}

export type SymbolSource = {
  text: FilePartSourceText
  type: "symbol"
  path: string
  range: Range
  name: string
  kind: number
}

export type ResourceSource = {
  text: FilePartSourceText
  type: "resource"
  clientName: string
  uri: string
}

export type FilePartSource = FileSource | SymbolSource | ResourceSource

export type FilePart = {
  id: string
  sessionID: string
  messageID: string
  type: "file"
  mime: string
  filename?: string
  url: string
  source?: FilePartSource
}

export type ToolStatePending = {
  status: "pending"
  input: {
    [key: string]: unknown
  }
  raw: string
}

export type ToolStateRunning = {
  status: "running"
  input: {
    [key: string]: unknown
  }
  title?: string
  metadata?: {
    [key: string]: unknown
  }
  time: {
    start: number
  }
}

export type ToolStateCompleted = {
  status: "completed"
  input: {
    [key: string]: unknown
  }
  output: string
  title: string
  metadata: {
    [key: string]: unknown
  }
  time: {
    start: number
    end: number
    compacted?: number
  }
  attachments?: Array<FilePart>
}

export type ToolStateError = {
  status: "error"
  input: {
    [key: string]: unknown
  }
  error: string
  metadata?: {
    [key: string]: unknown
  }
  time: {
    start: number
    end: number
  }
}

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export type ToolPart = {
  id: string
  sessionID: string
  messageID: string
  type: "tool"
  callID: string
  tool: string
  state: ToolState
  metadata?: {
    [key: string]: unknown
  }
}

export type StepStartPart = {
  id: string
  sessionID: string
  messageID: string
  type: "step-start"
  snapshot?: string
}

export type StepFinishPart = {
  id: string
  sessionID: string
  messageID: string
  type: "step-finish"
  reason: string
  snapshot?: string
  cost: number
  tokens: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
}

export type SnapshotPart = {
  id: string
  sessionID: string
  messageID: string
  type: "snapshot"
  snapshot: string
}

export type PatchPart = {
  id: string
  sessionID: string
  messageID: string
  type: "patch"
  hash: string
  files: Array<string>
}

export type AgentPart = {
  id: string
  sessionID: string
  messageID: string
  type: "agent"
  name: string
  source?: {
    value: string
    start: number
    end: number
  }
}

export type RetryPart = {
  id: string
  sessionID: string
  messageID: string
  type: "retry"
  attempt: number
  error: ApiError
  time: {
    created: number
  }
}

export type CompactionPart = {
  id: string
  sessionID: string
  messageID: string
  type: "compaction"
  auto: boolean
  overflow?: boolean
  tail_start_id?: string
}

export type Part =
  | TextPart
  | SubtaskPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart

export type Prompt = {
  text: string
  files?: Array<PromptFileAttachment>
  agents?: Array<PromptAgentAttachment>
}

export type Model = {
  id: string
  providerID: string
  api: {
    id: string
    url: string
    npm: string
  }
  name: string
  family?: string
  capabilities: {
    temperature: boolean
    reasoning: boolean
    attachment: boolean
    toolcall: boolean
    input: {
      text: boolean
      audio: boolean
      image: boolean
      video: boolean
      pdf: boolean
    }
    output: {
      text: boolean
      audio: boolean
      image: boolean
      video: boolean
      pdf: boolean
    }
    interleaved:
      | boolean
      | {
          field: "reasoning" | "reasoning_content" | "reasoning_text" | string
        }
  }
  cost: {
    input: number
    output: number
    cache: {
      read: number
      write: number
    }
    tiers?: Array<{
      input: number
      output: number
      cache: {
        read: number
        write: number
      }
      tier: {
        type: "context"
        size: number
      }
    }>
    experimentalOver200K?: {
      input: number
      output: number
      cache: {
        read: number
        write: number
      }
    }
  }
  limit: {
    context: number
    input?: number
    output: number
  }
  status: "alpha" | "beta" | "deprecated" | "active"
  options: {
    [key: string]: unknown
  }
  headers: {
    [key: string]: string
  }
  release_date: string
  variants?: {
    [key: string]: {
      [key: string]: unknown
    }
  }
}

export type Provider = {
  id: string
  name: string
  source: "env" | "config" | "custom" | "api"
  env: Array<string>
  key?: string
  options: {
    [key: string]: unknown
  }
  models: {
    [key: string]: Model
  }
}

export type ConsoleState = {
  consoleManagedProviders: Array<string>
  activeOrgName?: string
  switchableOrgCount: number
}

export type McpResource = {
  name: string
  uri: string
  description?: string
  mimeType?: string
  client: string
}

export type VcsInfo = {
  branch?: string
  default_branch?: string
}

export type VcsFileStatus = {
  file: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

export type VcsFileDiff = {
  file: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

export type McpStatusConnected = {
  status: "connected"
}

export type McpStatusDisabled = {
  status: "disabled"
}

export type McpStatusFailed = {
  status: "failed"
  error: string
}

export type McpStatusNeedsAuth = {
  status: "needs_auth"
}

export type McpStatusNeedsClientRegistration = {
  status: "needs_client_registration"
  error: string
}

export type ProviderAuthMethod = {
  type: "oauth" | "api"
  label: string
  prompts?: Array<
    | {
        type: "text"
        key: string
        message: string
        placeholder?: string
        when?: {
          key: string
          op: "eq" | "neq"
          value: string
        }
      }
    | {
        type: "select"
        key: string
        message: string
        options: Array<{
          label: string
          value: string
          hint?: string
        }>
        when?: {
          key: string
          op: "eq" | "neq"
          value: string
        }
      }
  >
}

export type ProviderAuthAuthorization = {
  url: string
  method: "auto" | "code"
  instructions: string
}

export type SessionsResponse = {
  data: Array<SessionV2Info>
  cursor: {
    previous?: string
    next?: string
  }
}

export type SessionDurableEvent =
  | SessionNextAgentSwitched
  | SessionNextModelSwitched
  | SessionNextMoved
  | SessionNextPrompted
  | SessionNextPromptAdmitted
  | SessionNextContextUpdated
  | SessionNextSynthetic
  | SessionNextShellStarted
  | SessionNextShellEnded
  | SessionNextStepStarted
  | SessionNextStepEnded
  | SessionNextStepFailed
  | SessionNextTextStarted
  | SessionNextTextEnded
  | SessionNextToolInputStarted
  | SessionNextToolInputEnded
  | SessionNextToolCalled
  | SessionNextToolProgress
  | SessionNextToolSuccess
  | SessionNextToolFailed
  | SessionNextReasoningStarted
  | SessionNextReasoningEnded
  | SessionNextRetried
  | SessionNextCompactionStarted
  | SessionNextCompactionEnded
  | SessionNextRevertStaged
  | SessionNextRevertCleared
  | SessionNextRevertCommitted

export type SessionHistory = {
  data: Array<SessionDurableEvent>
  hasMore: boolean
}

export type SessionMessagesResponse = {
  data: Array<SessionMessage>
  cursor: {
    previous?: string
    next?: string
  }
}

export type IntegrationMethod = IntegrationOAuthMethod | IntegrationKeyMethod | IntegrationEnvMethod

export type ModelRef = {
  id: string
  providerID: string
  variant?: string
}

export type LocationRef = {
  directory: string
  workspaceID?: string
}

export type PromptSource = {
  start: number
  end: number
  text: string
}

export type PromptFileAttachment = {
  uri: string
  mime: string
  name?: string
  description?: string
  source?: PromptSource
}

export type PromptAgentAttachment = {
  name: string
  source?: PromptSource
}

export type SessionErrorUnknown = {
  type: "unknown"
  message: string
}

export type LlmProviderMetadata = {
  [key: string]: {
    [key: string]: unknown
  }
}

export type ToolTextContent = {
  type: "text"
  text: string
}

export type ToolFileContent = {
  type: "file"
  uri: string
  mime: string
  name?: string
}

export type LlmToolContent = ToolTextContent | ToolFileContent

export type SessionNextRetryError = {
  message: string
  statusCode?: number
  isRetryable: boolean
  responseHeaders?: {
    [key: string]: string
  }
  responseBody?: string
  metadata?: {
    [key: string]: string
  }
}

export type FileDiff = {
  path: string
  status: "added" | "modified" | "deleted"
  additions: number
  deletions: number
  patch: string
}

export type RevertState = {
  messageID: string
  partID?: string
  snapshot?: string
  diff?: string
  files?: Array<FileDiff>
}

export type PermissionV2Source = {
  type: "tool"
  messageID: string
  callID: string
}

export type QuestionV2Option = {
  /**
   * Display text (1-5 words, concise)
   */
  label: string
  /**
   * Explanation of choice
   */
  description: string
}

export type QuestionV2Info = {
  /**
   * Complete question
   */
  question: string
  /**
   * Very short label (max 30 chars)
   */
  header: string
  /**
   * Available choices
   */
  options: Array<QuestionV2Option>
  multiple?: boolean
  custom?: boolean
}

export type QuestionV2Tool = {
  messageID: string
  callID: string
}

export type ProviderRequest = {
  headers: {
    [key: string]: string
  }
  body: {
    [key: string]: unknown
  }
}

export type AgentColor = string | "primary" | "secondary" | "accent" | "success" | "warning" | "error" | "info"

export type PermissionV2Effect = "allow" | "deny" | "ask"

export type PermissionV2Rule = {
  action: string
  resource: string
  effect: PermissionV2Effect
}

export type PermissionV2Ruleset = Array<PermissionV2Rule>

export type AgentV2Info = {
  id: string
  model?: ModelRef
  request: ProviderRequest
  system?: string
  description?: string
  mode: "subagent" | "primary" | "all"
  hidden: boolean
  color?: AgentColor
  steps?: number
  permissions: PermissionV2Ruleset
}

export type SessionV2Info = {
  id: string
  parentID?: string
  projectID: string
  agent?: string
  model?: ModelRef
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  time: {
    created: number
    updated: number
    archived?: number
  }
  title: string
  location: LocationRef
  subpath?: string
  revert?: RevertState
  permission?: PermissionRuleset
}

export type SessionInputAdmitted = {
  admittedSeq: number
  id: string
  sessionID: string
  prompt: Prompt
  delivery: "steer" | "queue"
  timeCreated: number
  promotedSeq?: number
}

export type SessionMessageAgentSwitched = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  time: {
    created: number
  }
  type: "agent-switched"
  agent: string
}

export type SessionMessageModelSwitched = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  time: {
    created: number
  }
  type: "model-switched"
  model: ModelRef
}

export type SessionMessageUser = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  time: {
    created: number
  }
  text: string
  files?: Array<PromptFileAttachment>
  agents?: Array<PromptAgentAttachment>
  type: "user"
}

export type SessionMessageSynthetic = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  time: {
    created: number
  }
  sessionID: string
  text: string
  type: "synthetic"
}

export type SessionMessageSystem = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  time: {
    created: number
  }
  type: "system"
  text: string
}

export type SessionMessageShell = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  time: {
    created: number
    completed?: number
  }
  type: "shell"
  callID: string
  command: string
  output: string
}

export type SessionMessageAssistantText = {
  type: "text"
  id: string
  text: string
}

export type SessionMessageAssistantReasoning = {
  type: "reasoning"
  id: string
  text: string
  providerMetadata?: LlmProviderMetadata
  time?: {
    created: number
    completed?: number
  }
}

export type SessionMessageToolStatePending = {
  status: "pending"
  input: string
}

export type SessionMessageToolStateRunning = {
  status: "running"
  input: {
    [key: string]: unknown
  }
  structured: {
    [key: string]: unknown
  }
  content: Array<LlmToolContent>
}

export type SessionMessageToolStateCompleted = {
  status: "completed"
  input: {
    [key: string]: unknown
  }
  attachments?: Array<PromptFileAttachment>
  content: Array<LlmToolContent>
  outputPaths?: Array<string>
  structured: {
    [key: string]: unknown
  }
  result?: unknown
}

export type SessionMessageToolStateError = {
  status: "error"
  input: {
    [key: string]: unknown
  }
  content: Array<LlmToolContent>
  structured: {
    [key: string]: unknown
  }
  error: SessionErrorUnknown
  result?: unknown
}

export type SessionMessageAssistantTool = {
  type: "tool"
  id: string
  name: string
  provider?: {
    executed: boolean
    metadata?: LlmProviderMetadata
    resultMetadata?: LlmProviderMetadata
  }
  state:
    | SessionMessageToolStatePending
    | SessionMessageToolStateRunning
    | SessionMessageToolStateCompleted
    | SessionMessageToolStateError
  time: {
    created: number
    ran?: number
    completed?: number
    pruned?: number
  }
}

export type SessionMessageAssistant = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  time: {
    created: number
    completed?: number
  }
  type: "assistant"
  agent: string
  model: ModelRef
  content: Array<SessionMessageAssistantText | SessionMessageAssistantReasoning | SessionMessageAssistantTool>
  snapshot?: {
    start?: string
    end?: string
    files?: Array<string>
  }
  finish?: string
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  error?: SessionErrorUnknown
}

export type SessionMessageCompaction = {
  type: "compaction"
  reason: "auto" | "manual"
  summary: string
  recent: string
  id: string
  metadata?: {
    [key: string]: unknown
  }
  time: {
    created: number
  }
}

export type SessionMessage =
  | SessionMessageAgentSwitched
  | SessionMessageModelSwitched
  | SessionMessageUser
  | SessionMessageSynthetic
  | SessionMessageSystem
  | SessionMessageShell
  | SessionMessageAssistant
  | SessionMessageCompaction

export type SessionNextAgentSwitched = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.agent.switched"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    messageID: string
    agent: string
  }
}

export type SessionNextModelSwitched = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.model.switched"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    messageID: string
    model: ModelRef
  }
}

export type SessionNextMoved = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.moved"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    location: LocationRef
    subdirectory?: string
  }
}

export type SessionNextPrompted = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.prompted"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    messageID: string
    prompt: Prompt
    delivery: "steer" | "queue"
  }
}

export type SessionNextPromptAdmitted = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.prompt.admitted"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    messageID: string
    prompt: Prompt
    delivery: "steer" | "queue"
  }
}

export type SessionNextContextUpdated = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.context.updated"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    messageID: string
    text: string
  }
}

export type SessionNextSynthetic = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.synthetic"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    messageID: string
    text: string
  }
}

export type SessionNextShellStarted = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.shell.started"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    messageID: string
    callID: string
    command: string
  }
}

export type SessionNextShellEnded = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.shell.ended"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    callID: string
    output: string
  }
}

export type SessionNextStepStarted = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.step.started"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    assistantMessageID: string
    agent: string
    model: ModelRef
    snapshot?: string
  }
}

export type SessionNextStepEnded = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.step.ended"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    assistantMessageID: string
    finish: string
    cost: number
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: {
        read: number
        write: number
      }
    }
    snapshot?: string
    files?: Array<string>
  }
}

export type SessionNextStepFailed = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.step.failed"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    assistantMessageID: string
    error: SessionErrorUnknown
  }
}

export type SessionNextTextStarted = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.text.started"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    assistantMessageID: string
    textID: string
  }
}

export type SessionNextTextEnded = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.text.ended"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    assistantMessageID: string
    textID: string
    text: string
  }
}

export type SessionNextToolInputStarted = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.tool.input.started"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    assistantMessageID: string
    callID: string
    name: string
  }
}

export type SessionNextToolInputEnded = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.tool.input.ended"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    assistantMessageID: string
    callID: string
    text: string
  }
}

export type SessionNextToolCalled = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.tool.called"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    assistantMessageID: string
    callID: string
    tool: string
    input: {
      [key: string]: unknown
    }
    provider: {
      executed: boolean
      metadata?: LlmProviderMetadata
    }
  }
}

export type SessionNextToolProgress = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.tool.progress"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    assistantMessageID: string
    callID: string
    structured: {
      [key: string]: unknown
    }
    content: Array<LlmToolContent>
  }
}

export type SessionNextToolSuccess = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.tool.success"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    assistantMessageID: string
    callID: string
    structured: {
      [key: string]: unknown
    }
    content: Array<LlmToolContent>
    outputPaths?: Array<string>
    result?: unknown
    provider: {
      executed: boolean
      metadata?: LlmProviderMetadata
    }
  }
}

export type SessionNextToolFailed = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.tool.failed"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    assistantMessageID: string
    callID: string
    error: SessionErrorUnknown
    result?: unknown
    provider: {
      executed: boolean
      metadata?: LlmProviderMetadata
    }
  }
}

export type SessionNextReasoningStarted = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.reasoning.started"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    assistantMessageID: string
    reasoningID: string
    providerMetadata?: LlmProviderMetadata
  }
}

export type SessionNextReasoningEnded = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.reasoning.ended"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    assistantMessageID: string
    reasoningID: string
    text: string
    providerMetadata?: LlmProviderMetadata
  }
}

export type SessionNextRetried = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.retried"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    attempt: number
    error: SessionNextRetryError
  }
}

export type SessionNextCompactionStarted = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.compaction.started"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    messageID: string
    reason: "auto" | "manual"
  }
}

export type SessionNextCompactionEnded = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.compaction.ended"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    messageID: string
    reason: "auto" | "manual"
    text: string
    recent: string
  }
}

export type SessionNextRevertStaged = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.revert.staged"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    revert: RevertState
  }
}

export type SessionNextRevertCleared = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.revert.cleared"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
  }
}

export type SessionNextRevertCommitted = {
  id: string
  metadata?: {
    [key: string]: unknown
  }
  type: "session.next.revert.committed"
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: LocationRef
  data: {
    timestamp: number
    sessionID: string
    messageID: string
  }
}

export type ModelApi =
  | {
      id: string
      type: "aisdk"
      package: string
      url?: string
      settings?: {
        [key: string]: unknown
      }
    }
  | {
      id: string
      type: "native"
      url?: string
      settings: {
        [key: string]: unknown
      }
    }

export type ModelCapabilities = {
  tools: boolean
  input: Array<string>
  output: Array<string>
}

export type ModelCost = {
  tier?: {
    type: "context"
    size: number
  }
  input: number
  output: number
  cache: {
    read: number
    write: number
  }
}

export type ModelV2Info = {
  id: string
  providerID: string
  family?: string
  name: string
  api: ModelApi
  capabilities: ModelCapabilities
  request: {
    headers: {
      [key: string]: string
    }
    body: {
      [key: string]: unknown
    }
    variant?: string
  }
  variants: Array<{
    id: string
    headers: {
      [key: string]: string
    }
    body: {
      [key: string]: unknown
    }
  }>
  time: {
    released: number
  }
  cost: Array<ModelCost>
  status: "alpha" | "beta" | "deprecated" | "active"
  enabled: boolean
  limit: {
    context: number
    input?: number
    output: number
  }
}

export type ProviderAisdk = {
  type: "aisdk"
  package: string
  url?: string
  settings?: {
    [key: string]: unknown
  }
}

export type ProviderNative = {
  type: "native"
  url?: string
  settings: {
    [key: string]: unknown
  }
}

export type ProviderApi = ProviderAisdk | ProviderNative

export type ProviderV2Info = {
  id: string
  integrationID?: string
  name: string
  disabled?: boolean
  api: ProviderApi
  request: ProviderRequest
}

export type IntegrationWhen = {
  key: string
  op: "eq" | "neq"
  value: string
}

export type IntegrationTextPrompt = {
  type: "text"
  key: string
  message: string
  placeholder?: string
  when?: IntegrationWhen
}

export type IntegrationSelectPrompt = {
  type: "select"
  key: string
  message: string
  options: Array<{
    label: string
    value: string
    hint?: string
  }>
  when?: IntegrationWhen
}

export type IntegrationOAuthMethod = {
  id: string
  type: "oauth"
  label: string
  prompts?: Array<IntegrationTextPrompt | IntegrationSelectPrompt>
}

export type IntegrationKeyMethod = {
  type: "key"
  label?: string
}

export type IntegrationEnvMethod = {
  type: "env"
  names: Array<string>
}

export type ConnectionCredentialInfo = {
  type: "credential"
  id: string
  label: string
}

export type ConnectionEnvInfo = {
  type: "env"
  name: string
}

export type ConnectionInfo = ConnectionCredentialInfo | ConnectionEnvInfo

export type IntegrationInfo = {
  id: string
  name: string
  methods: Array<IntegrationMethod>
  connections: Array<ConnectionInfo>
}

export type IntegrationAttempt = {
  attemptID: string
  url: string
  instructions: string
  mode: "auto" | "code"
  time: {
    created: number | "NaN" | "Infinity" | "-Infinity" | "Infinity" | "-Infinity" | "NaN"
    expires: number | "NaN" | "Infinity" | "-Infinity" | "Infinity" | "-Infinity" | "NaN"
  }
}

export type IntegrationAttemptStatus =
  | {
      status: "pending"
      time: {
        created: number | "NaN" | "Infinity" | "-Infinity" | "Infinity" | "-Infinity" | "NaN"
        expires: number | "NaN" | "Infinity" | "-Infinity" | "Infinity" | "-Infinity" | "NaN"
      }
    }
  | {
      status: "complete"
      time: {
        created: number | "NaN" | "Infinity" | "-Infinity" | "Infinity" | "-Infinity" | "NaN"
        expires: number | "NaN" | "Infinity" | "-Infinity" | "Infinity" | "-Infinity" | "NaN"
      }
    }
  | {
      status: "failed"
      message: string
      time: {
        created: number | "NaN" | "Infinity" | "-Infinity" | "Infinity" | "-Infinity" | "NaN"
        expires: number | "NaN" | "Infinity" | "-Infinity" | "Infinity" | "-Infinity" | "NaN"
      }
    }
  | {
      status: "expired"
      time: {
        created: number | "NaN" | "Infinity" | "-Infinity" | "Infinity" | "-Infinity" | "NaN"
        expires: number | "NaN" | "Infinity" | "-Infinity" | "Infinity" | "-Infinity" | "NaN"
      }
    }

export type PermissionV2Request = {
  id: string
  sessionID: string
  action: string
  resources: Array<string>
  save?: Array<string>
  metadata?: {
    [key: string]: unknown
  }
  source?: PermissionV2Source
}

export type PermissionSavedInfo = {
  id: string
  projectID: string
  action: string
  resource: string
}

export type FileSystemEntry = {
  path: string
  type: "file" | "directory"
}

export type CommandV2Info = {
  name: string
  template: string
  description?: string
  agent?: string
  model?: ModelRef
  subtask?: boolean
}

export type MemorySourceRef = {
  sessionID?: string
  messageID?: string
  toolCallID?: string
  path?: string
  url?: string
}

export type MemoryValidationAnchor = {
  kind: "file" | "directory" | "command" | "url" | "script" | "config"
  value: string
  ok: boolean
  checkedAt?: number
}

export type MemoryValidation = {
  anchors: Array<MemoryValidationAnchor>
}

export type MemoryInfo = {
  id: string
  scope: "global" | "project" | "agent" | "session"
  scopeID: string
  kind:
    | "fact"
    | "convention"
    | "procedure"
    | "preference"
    | "constraint"
    | "workflow"
    | "decision"
    | "issue"
    | "solution"
  title: string
  content: string
  tags: Array<string>
  source:
    | "explicit_user"
    | "agent_tool"
    | "agent_discovery"
    | "repository_file"
    | "conversation"
    | "tool_result"
    | "manual"
    | "import"
  sourceRef?: MemorySourceRef
  status: "candidate" | "active" | "stale" | "archived"
  confidence: number
  importance: number
  createdBy: string
  directory?: string
  validatedAt?: number
  validation?: MemoryValidation
  supersededBy?: string
  timeCreated: number
  timeUpdated: number
  timeLastUsed?: number
  useCount: number
}

export type SkillV2Info = {
  name: string
  description?: string
  slash?: boolean
  location: string
  content: string
}

export type QuestionV2Request = {
  id: string
  sessionID: string
  /**
   * Questions to ask
   */
  questions: Array<QuestionV2Info>
  tool?: QuestionV2Tool
}
