import type {
  FormInfo as V2Form,
  IntegrationInfo as V2Integration,
  ModelInfo as V2Model,
  ProviderInfo as V2Provider,
  PermissionRequest as V2Permission,
  SessionInfo as V2Session,
  SessionMessageAssistant as V2Assistant,
  SessionMessageInfo as V2Message,
  ToolContent as V2ToolContent,
} from "@opencode/client"
import type {
  IntegrationInfo,
  ModelInfo,
  PermissionV2Request,
  ProviderDirectoryInfo,
  ProviderInfo,
  QuestionV2Request,
  SessionInfo,
  SessionMessageInfo,
} from "../engine-types"

/**
 * OpenCode 2's session and message shapes, turned into the ones the app renders today (V2-20).
 *
 * The app was built on the 1.x engine's `/api` shapes, which OpenCode 2 grew out of, so most fields
 * carry over. What does not: tool states are `streaming` where the app knows `pending`, errors are
 * structured, text has no id, permissions are `{action, resource, effect}` rules, and a few message
 * kinds are new. Kinds the app has no view for (`idle`, `location-switched`, `skill`) are dropped;
 * the turn's outcome reaches the app through events instead (V2-21).
 */
export function toSession(session: V2Session): SessionInfo {
  return {
    id: session.id,
    ...(session.parentID ? { parentID: session.parentID } : {}),
    projectID: session.projectID,
    ...(session.agent ? { agent: session.agent } : {}),
    ...(session.model ? { model: session.model } : {}),
    cost: Number(session.cost),
    tokens: session.tokens,
    time: {
      created: session.time.created,
      updated: session.time.updated,
      ...(session.time.archived ? { archived: session.time.archived } : {}),
    },
    title: session.title ?? "",
    location: { directory: session.location.directory },
    ...(session.subpath ? { subpath: session.subpath } : {}),
    ...(session.permissions
      ? {
          permission: session.permissions.map((rule) => ({
            permission: rule.action,
            pattern: rule.resource,
            action: rule.effect,
          })),
        }
      : {}),
  }
}

/** Oldest first, with the kinds the app has no view for left out. */
export function toMessages(messages: readonly V2Message[]) {
  return messages.flatMap((message) => {
    const converted = toMessage(message)
    return converted ? [converted] : []
  })
}

export function toMessage(message: V2Message): SessionMessageInfo | undefined {
  const base = { id: message.id, time: { created: message.time.created }, ...metadataOf(message) }
  if (message.type === "user")
    return {
      ...base,
      type: "user",
      text: message.text,
      ...(message.files?.length
        ? {
            files: message.files.map((file) => ({
              uri: file.source.type === "uri" ? file.source.uri : `data:${file.mime};base64,${file.data}`,
              mime: file.mime,
              ...(file.name ? { name: file.name } : {}),
              ...(file.description ? { description: file.description } : {}),
            })),
          }
        : {}),
      ...(message.agents?.length ? { agents: message.agents.map((agent) => ({ name: agent.name })) } : {}),
    }
  if (message.type === "assistant") return toAssistant(message)
  if (message.type === "synthetic") return { ...base, type: "synthetic", sessionID: "", text: message.text }
  if (message.type === "system") return { ...base, type: "system", text: message.text }
  if (message.type === "agent-switched") return { ...base, type: "agent-switched", agent: message.agent }
  if (message.type === "model-switched") return { ...base, type: "model-switched", model: message.model }
  if (message.type === "shell")
    return {
      ...base,
      time: { created: message.time.created, ...(message.time.completed ? { completed: message.time.completed } : {}) },
      type: "shell",
      callID: message.shellID,
      command: message.command,
      output: message.output?.output ?? "",
    }
  // Only a finished compaction has a summary to show; one still running, or failed, has none.
  if (message.type === "compaction" && message.status === "completed")
    return { ...base, type: "compaction", reason: message.reason, summary: message.summary, recent: message.recent }
  return undefined
}

function toAssistant(message: V2Assistant): SessionMessageInfo {
  return {
    id: message.id,
    ...metadataOf(message),
    time: {
      created: message.time.created,
      ...(message.time.completed ? { completed: message.time.completed } : {}),
    },
    type: "assistant",
    agent: message.agent,
    model: message.model,
    content: message.content.map((item, index) => {
      // 2.x text and reasoning carry no id; the app keys content by it, and the position is stable.
      const id = `${message.id}:${index}`
      if (item.type === "text") return { type: "text" as const, id, text: item.text }
      if (item.type === "reasoning") return { type: "reasoning" as const, id, text: item.text }
      return {
        type: "tool" as const,
        id: item.id,
        name: item.name,
        state: toolState(item.state),
        time: item.time,
      }
    }),
    ...(message.snapshot ? { snapshot: message.snapshot } : {}),
    ...(message.finish ? { finish: message.finish } : {}),
    ...(message.cost !== undefined ? { cost: Number(message.cost) } : {}),
    ...(message.tokens ? { tokens: message.tokens } : {}),
    ...(message.error ? { error: { type: "unknown" as const, message: message.error.message } } : {}),
  }
}

type V2Tool = Extract<V2Assistant["content"][number], { type: "tool" }>

function toolState(state: V2Tool["state"]) {
  if (state.status === "streaming") return { status: "pending" as const, input: state.input }
  if (state.status === "running")
    return { status: "running" as const, input: state.input, structured: state.metadata, content: [] }
  if (state.status === "completed")
    return {
      status: "completed" as const,
      input: state.input,
      content: toolContent(state.content),
      structured: state.metadata ?? {},
    }
  return {
    status: "error" as const,
    input: state.input,
    content: toolContent(state.content ?? []),
    structured: state.metadata ?? {},
    error: { type: "unknown" as const, message: state.error.message },
  }
}

/** 2.x lets a file result's `name` be `null`; the app's shape only knows it missing. */
function toolContent(items: readonly V2ToolContent[]) {
  return items.map((item) => (item.type === "file" ? { ...item, name: item.name ?? undefined } : item))
}

function metadataOf(message: V2Message) {
  return message.metadata ? { metadata: message.metadata } : {}
}

/** A 2.x permission request is the app's own shape but for its tool call, which 2.x names `id`. */
export function toPermission(request: V2Permission): PermissionV2Request {
  return {
    id: request.id,
    sessionID: request.sessionID,
    action: request.action,
    resources: request.resources,
    ...(request.save ? { save: request.save } : {}),
    ...(request.metadata ? { metadata: request.metadata } : {}),
    ...(request.source
      ? { source: { type: "tool" as const, messageID: request.source.messageID, callID: request.source.id } }
      : {}),
  }
}

/**
 * 2.x asks every question as a form (V2-22). The `question` tool turns each question into one field,
 * `q0`, `q1`…: its header as the title, the question as the description, `multiselect` when several
 * answers may be picked, every option's value being its label, and a custom answer always allowed.
 * That is exactly the app's question, so its dock answers a form unchanged. A form from anything else
 * reads the same way, field by field: a yes/no field as two options, a number as a typed answer.
 */
export function toQuestion(form: V2Form): QuestionV2Request {
  const tool = (form.metadata as { tool?: { messageID?: string; id?: string } } | undefined)?.tool
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions: form.fields.flatMap((field) => {
      if (field.type === "external" || ("hidden" in field && field.hidden)) return []
      const title = field.title ?? field.key
      const options =
        field.type === "boolean"
          ? [
              { label: "Yes", description: "" },
              { label: "No", description: "" },
            ]
          : "options" in field && field.options
            ? field.options.map((option) => ({ label: option.label, description: option.description ?? "" }))
            : []
      return [
        {
          question: field.description ?? title,
          header: title,
          options,
          ...(field.type === "multiselect" ? { multiple: true } : {}),
          // Nothing to pick from means the answer is typed.
          custom: options.length === 0 || ("custom" in field && field.custom === true),
        },
      ]
    }),
    ...(tool?.messageID && tool.id ? { tool: { messageID: tool.messageID, callID: tool.id } } : {}),
  }
}

/** The dock's answers, one list of picked labels per question, as the form's answer by field key. */
export function toFormAnswer(form: V2Form, answers: string[][]) {
  const fields = form.fields.filter((field) => field.type !== "external" && !("hidden" in field && field.hidden))
  return Object.fromEntries(
    fields.flatMap((field, index): Array<[string, string | number | boolean | string[]]> => {
      const picked = answers[index] ?? []
      if (picked.length === 0) return []
      // A picked option answers with its value; anything else was typed.
      const value = (label: string) =>
        ("options" in field ? field.options?.find((option) => option.label === label)?.value : undefined) ?? label
      if (field.type === "multiselect") return [[field.key, picked.map(value)]]
      if (field.type === "boolean") return [[field.key, picked[0] === "Yes"]]
      if (field.type === "number" || field.type === "integer") return [[field.key, Number(picked[0])]]
      return [[field.key, value(picked[0]!)]]
    }),
  )
}

/**
 * A 2.x model in the app's shape (V2-25). 2.x flattens what 1.x kept under `api` and `request`. Its
 * `settings` are left out on purpose: they can carry the provider's API key, which nothing in the app
 * needs and which must not reach a phone over remote control (the 1.x adapter drops keys for the same
 * reason).
 */
export function toModel(model: V2Model): ModelInfo {
  return {
    id: model.id,
    providerID: model.providerID,
    ...(model.family ? { family: model.family } : {}),
    name: model.name,
    api: { id: model.modelID, type: "aisdk", package: model.package ?? "" },
    capabilities: model.capabilities,
    request: { headers: model.headers ?? {}, body: model.body ?? {} },
    variants: model.variants.map((variant) => ({
      id: variant.id,
      headers: variant.headers ?? {},
      body: variant.body ?? {},
    })),
    time: model.time,
    cost: model.cost,
    status: model.status,
    enabled: model.enabled,
    limit: model.limit,
  }
}

/** A 2.x provider in the app's shape, without its settings for the same reason as `toModel`. */
export function toProvider(provider: V2Provider): ProviderInfo {
  return {
    id: provider.id,
    ...(provider.integrationID ? { integrationID: provider.integrationID } : {}),
    name: provider.name,
    ...(provider.activation === "disabled" ? { disabled: true } : {}),
    api: { type: "aisdk", package: provider.package },
    request: { headers: provider.headers ?? {}, body: provider.body ?? {} },
  }
}

/**
 * 2.x's integration in the app's shape. Its OAuth and key methods ask their questions as a form where
 * 1.x had `prompts`; the providers panel only reads a method's type and id, so the form is dropped.
 */
export function toIntegration(integration: V2Integration): IntegrationInfo {
  return {
    id: integration.id,
    name: integration.name,
    methods: integration.methods.flatMap((method): IntegrationInfo["methods"] => {
      if (method.type === "oauth") return [{ id: method.id, type: "oauth" as const, label: method.label }]
      if (method.type === "key") return [{ type: "key" as const, ...(method.label ? { label: method.label } : {}) }]
      if (method.type === "env") return [{ type: "env" as const, names: method.names }]
      // A command method (a CLI that signs in on its own) has no 1.x counterpart.
      return []
    }),
    connections: integration.connections,
  }
}

/**
 * The 1.x provider directory (`GET /provider`), which the providers panel is built on, rebuilt from
 * 2.x's integrations (every provider it knows) and providers (the ones that can serve a model). A
 * provider that has no integration of its own was declared in the config. Models are only counted by
 * the panel, so each is an empty entry; no key ever travels.
 */
export function toProviderDirectory(input: {
  integrations: readonly V2Integration[]
  providers: readonly V2Provider[]
  models: readonly V2Model[]
}) {
  const ids = [...new Set([...input.integrations.map((item) => item.id), ...input.providers.map((item) => item.id)])]
  const all = ids.map((id): ProviderDirectoryInfo => {
    const integration = input.integrations.find((item) => item.id === id)
    const provider = input.providers.find((item) => item.id === id)
    const env = integration?.methods.flatMap((method) => (method.type === "env" ? method.names : [])) ?? []
    return {
      id,
      name: provider?.name ?? integration?.name ?? id,
      source: provider && !provider.integrationID ? "config" : "api",
      env,
      options: {},
      models: Object.fromEntries(
        input.models.filter((model) => model.providerID === id).map((model) => [model.id, {}]),
      ) as ProviderDirectoryInfo["models"],
    }
  })
  return {
    all,
    default: {} as Record<string, string>,
    connected: input.providers.filter((provider) => provider.activation !== "disabled").map((provider) => provider.id),
  }
}
