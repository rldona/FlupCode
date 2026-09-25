const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/
const EFFORT_LEVEL = /^[a-z0-9_-]+$/
const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible"

type Translator = (key: string, vars?: Record<string, string | number>) => string

export type ModelErr = {
  id?: string
  name?: string
  effort?: string
}

export type HeaderErr = {
  key?: string
  value?: string
}

export type ModelRow = {
  row: string
  id: string
  name: string
  effort: string
  err: ModelErr
}

export type HeaderRow = {
  row: string
  key: string
  value: string
  err: HeaderErr
}

export type FormState = {
  providerID: string
  name: string
  baseURL: string
  apiKey: string
  models: ModelRow[]
  headers: HeaderRow[]
  err: {
    providerID?: string
    name?: string
    baseURL?: string
  }
}

export type CustomProviderResult = {
  providerID: string
  name: string
  key: string | undefined
  config: Record<string, unknown>
}

/** A provider already written to the global config, as the engine reads it back (V1 shape). */
export type ConfiguredProvider = {
  name?: string
  npm?: string
  options?: {
    baseURL?: string
    headers?: Record<string, string>
  }
  models?: Record<string, { name?: string; variants?: Record<string, unknown> }>
}

/** Only the OpenAI-compatible entries this form owns can be reopened; a known provider override is left alone. */
export const isEditableProvider = (provider: ConfiguredProvider) => provider.npm === OPENAI_COMPATIBLE

type ValidateArgs = {
  form: FormState
  t: Translator
  disabledProviders: string[]
  existingProviderIDs: Set<string>
  /** Ids already in the global config that this form may update in place. */
  editableProviderIDs: Set<string>
}

export function validateCustomProvider(input: ValidateArgs) {
  const providerID = input.form.providerID.trim()
  const name = input.form.name.trim()
  const baseURL = input.form.baseURL.trim()
  const apiKey = input.form.apiKey.trim()

  const env = apiKey.match(/^\{env:([^}]+)\}$/)?.[1]?.trim()
  const key = apiKey && !env ? apiKey : undefined

  const idError = !providerID
    ? input.t("Provider ID is required")
    : !PROVIDER_ID.test(providerID)
      ? input.t("Use lowercase letters, numbers, hyphens, or underscores")
      : undefined

  const nameError = !name ? input.t("Display name is required") : undefined
  const urlError = !baseURL
    ? input.t("Base URL is required")
    : !/^https?:\/\//.test(baseURL)
      ? input.t("Must start with http:// or https://")
      : undefined

  const disabled = input.disabledProviders.includes(providerID)
  const existsError = idError
    ? undefined
    : input.existingProviderIDs.has(providerID) && !disabled && !input.editableProviderIDs.has(providerID)
      ? input.t("That provider ID already exists")
      : undefined

  const seenModels = new Set<string>()
  const models = input.form.models.map((m) => {
    const id = m.id.trim()
    const idError = !id
      ? input.t("Required")
      : seenModels.has(id)
        ? input.t("Duplicate")
        : (() => {
            seenModels.add(id)
            return undefined
          })()
    const nameError = !m.name.trim() ? input.t("Required") : undefined
    return { id: idError, name: nameError, effort: effortError(m.effort, input.t) }
  })
  const modelsValid = models.every((m) => !m.id && !m.name && !m.effort)
  const modelConfig = Object.fromEntries(
    input.form.models.map((m) => {
      const levels = effortLevels(m.effort)
      const variants = Object.fromEntries(levels.map((level) => [level, { reasoningEffort: level }]))
      return [m.id.trim(), { name: m.name.trim(), ...(levels.length ? { variants } : {}) }]
    }),
  )

  const seenHeaders = new Set<string>()
  const headers = input.form.headers.map((h) => {
    const key = h.key.trim()
    const value = h.value.trim()

    if (!key && !value) return {}
    const keyError = !key
      ? input.t("Required")
      : seenHeaders.has(key.toLowerCase())
        ? input.t("Duplicate")
        : (() => {
            seenHeaders.add(key.toLowerCase())
            return undefined
          })()
    const valueError = !value ? input.t("Required") : undefined
    return { key: keyError, value: valueError }
  })
  const headersValid = headers.every((h) => !h.key && !h.value)
  const headerConfig = Object.fromEntries(
    input.form.headers
      .map((h) => ({ key: h.key.trim(), value: h.value.trim() }))
      .filter((h) => !!h.key && !!h.value)
      .map((h) => [h.key, h.value]),
  )

  const err = {
    providerID: idError ?? existsError,
    name: nameError,
    baseURL: urlError,
  }

  const ok = !idError && !existsError && !nameError && !urlError && modelsValid && headersValid
  if (!ok) return { err, models, headers }

  return {
    err,
    models,
    headers,
    result: {
      providerID,
      name,
      key,
      config: {
        npm: OPENAI_COMPATIBLE,
        name,
        ...(env ? { env: [env] } : {}),
        options: {
          baseURL,
          ...(Object.keys(headerConfig).length ? { headers: headerConfig } : {}),
        },
        models: modelConfig,
      },
    },
  }
}

/** The global-config patch that registers a custom provider and drops it from the disabled list. */
export function customProviderPayload(
  result: { providerID: string; config: Record<string, unknown> },
  currentDisabled: readonly string[],
) {
  return {
    provider: { [result.providerID]: result.config },
    disabled_providers: currentDisabled.filter((id) => id !== result.providerID),
  }
}

/** The reasoning effort levels written as variants, unique and lowercased. */
function effortLevels(input: string) {
  return Array.from(
    new Set(
      input
        .split(",")
        .map((level) => level.trim().toLowerCase())
        .filter(Boolean),
    ),
  )
}

function effortError(input: string, t: Translator) {
  const seen = new Set<string>()
  for (const level of input
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)) {
    if (!EFFORT_LEVEL.test(level)) return t("Use lowercase words separated by commas")
    if (seen.has(level)) return t("Duplicate")
    seen.add(level)
  }
  return undefined
}

/** The global-config ids this form may update in place, keyed by their OpenAI-compatible entries. */
export function editableProviderIDs(configured: Record<string, ConfiguredProvider> | undefined) {
  return new Set(
    Object.entries(configured ?? {})
      .filter(([, provider]) => isEditableProvider(provider))
      .map(([id]) => id),
  )
}

/** The form state for a provider already in the global config, so reopening it starts from what is there. */
export function formFromConfigured(entry: ConfiguredProvider) {
  const models = Object.entries(entry.models ?? {}).map(([id, model]) => ({
    ...modelRow(),
    id,
    name: model.name ?? id,
    effort: Object.keys(model.variants ?? {}).join(","),
  }))
  const headers = Object.entries(entry.options?.headers ?? {}).map(([key, value]) => ({
    ...headerRow(),
    key,
    value,
  }))
  return {
    name: entry.name ?? "",
    baseURL: entry.options?.baseURL ?? "",
    models: models.length ? models : [modelRow()],
    headers: headers.length ? headers : [headerRow()],
  }
}

let row = 0

const nextRow = () => `row-${row++}`

export const modelRow = (): ModelRow => ({ row: nextRow(), id: "", name: "", effort: "", err: {} })
export const headerRow = (): HeaderRow => ({ row: nextRow(), key: "", value: "", err: {} })
