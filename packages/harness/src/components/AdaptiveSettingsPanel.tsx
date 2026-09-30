import { For, Show, createEffect, createSignal, type Component, type JSX } from "solid-js"
import { t } from "../i18n"
import { adaptiveSurfaces } from "../client"
import type { AdaptiveConfigError } from "../client"
import type {
  AdaptiveConfigView,
  AdaptiveProvenance,
  AdaptiveProviderConsent,
  AdaptiveWritableField,
} from "../types"
import { Toggle } from "./Toggle"
import { ConfirmDialog } from "./ConfirmDialog"

/** The decision kinds E8 shows when editing a provider's consent: the four the server ships. */
export const ADAPTIVE_KINDS = ["completion", "skillRelevance", "contextItem", "skillReflection"] as const

/** Why a switch cannot be offered, with the words the panel shows. */
export type AdaptiveProblem = "env-disabled" | "no-adaptive-token" | "egress-allowlist"

/**
 * The fields a patch may carry, as the server's own descriptors allow.
 *
 * Exported so a test can pin the panel to the contract: a switch the server does not list is never
 * drawn, and the whole allowlist stays server-owned.
 */
export function writableField(view: AdaptiveConfigView, path: string): AdaptiveWritableField | undefined {
  const consent = consentPath(path)
  const wanted = consent ? `egress.providers.*.${consent.leaf}` : path
  return view.writable.find((field) => field.path === wanted)
}

/** The provider and leaf of a consent path (`egress.providers.<id>.<leaf>`), or undefined. */
export function consentPath(path: string): { provider: string; leaf: string } | undefined {
  const [root, group, provider, leaf, ...rest] = path.split(".")
  if (root !== "egress" || group !== "providers" || !provider || !leaf || rest.length > 0) return undefined
  return { provider, leaf }
}

/** One provider's resolved consent, or undefined when the server reports none for it. */
export function consentOf(view: AdaptiveConfigView, provider: string): AdaptiveProviderConsent | undefined {
  const providers = view.effective.egress.providers
  return Object.hasOwn(providers, provider) ? providers[provider] : undefined
}

/** The providers a consent row is drawn for: the server's list, else every provider it resolved. */
export function consentProviders(view: AdaptiveConfigView): string[] {
  return view.egressProviders ?? Object.keys(view.effective.egress.providers)
}

/**
 * Whether a field's guard can be met right now.
 *
 * The server evaluates the guards on the effective config *after* the patch, so this mirrors the
 * parts a single switch cannot change: the environment, the acting token (announced by the
 * `adaptive-relevance` and `adaptive-guardrails` capabilities, both only when the server resolved it)
 * and the provider consent the switch itself needs. A switch whose guard already fails is drawn
 * disabled with the reason, never as a control that would only 422. `path` is the concrete leaf, for a
 * consent descriptor whose own path names its provider as `*`.
 */
export function fieldProblem(
  field: AdaptiveWritableField,
  view: AdaptiveConfigView,
  capabilities: readonly string[],
  path = field.path,
): AdaptiveProblem | undefined {
  if (field.guard === "env-disabled" && view.env.adaptiveDisabled) return "env-disabled"
  if (
    field.guard === "adaptive-token" &&
    !capabilities.includes("adaptive-relevance") &&
    !capabilities.includes("adaptive-guardrails")
  )
    return "no-adaptive-token"
  if (field.guard !== "egress-allowlist") return undefined
  const ready = (provider: string, needsEnabled: boolean, kind?: string) => {
    const consent = consentOf(view, provider)
    if (!consent || consent.projects.length === 0 || (needsEnabled && !consent.enabled)) return false
    return kind ? consent.kinds[kind] === true : Object.values(consent.kinds).some(Boolean)
  }
  if (path === "learning.enabled") {
    // The classification goes to the model `skillReflection` is assigned to. One without a consent
    // row is not a remote provider the panel knows (a local model needs none): the server decides.
    const classifier = view.effective.models?.skillReflection ?? "jev"
    if (consentProviders(view).includes(classifier) && !ready(classifier, false, "skillReflection"))
      return "egress-allowlist"
    return undefined
  }
  if (path === "jev.enabled") return ready("jev", true) ? undefined : "egress-allowlist"
  const consent = consentPath(path)
  if (consent && !ready(consent.provider, false)) return "egress-allowlist"
  return undefined
}

/** The reason a guard shows, as an i18n key; undefined when the guard is satisfied. */
export function problemKey(problem: AdaptiveProblem): string {
  if (problem === "env-disabled") return "Disabled by FLUPCODE_ADAPTIVE_DISABLED=1"
  if (problem === "no-adaptive-token") return "This switch needs the acting token, which this server does not have."
  return "Enabling this needs the provider's egress consent, with a project and a kind, first."
}

/** The switches the master `enabled` stops on the server; retention sweeps run regardless of it. */
const MASTER_GATED = new Set([
  "shadow",
  "context.enabled",
  "context.apply",
  "learning.enabled",
  "relevance.enabled",
  "guardrails.enabled",
  "jev.enabled",
])

/**
 * Whether a switch is inert because the master switch is off. Its own value is kept and still shown,
 * so the panel says it is inactive instead of letting a bare "on" suggest it acts.
 */
export function inactiveByMaster(view: AdaptiveConfigView, path: string): boolean {
  return !view.effective.enabled && MASTER_GATED.has(path)
}

/**
 * The budget draft after the server's value moves from `before` to `after`.
 *
 * Any successful write answers the whole view, so the budget value is re-read even when another
 * switch saved: a draft the reader typed but did not save survives, and an untouched draft follows
 * the server.
 */
export function nextBudgetDraft(draft: string, before: string | undefined, after: string): string {
  if (before === undefined || draft === before) return after
  return draft
}

/** Whether a value widens a provider's consent, which the server only writes with `confirm: true`. */
function widens(path: string, value: unknown, view: AdaptiveConfigView): boolean {
  const consent = consentPath(path)
  if (!consent) return false
  const before = consentOf(view, consent.provider)
  if (consent.leaf === "projects" && Array.isArray(value)) {
    const known = new Set(before?.projects ?? [])
    return value.some((project) => typeof project === "string" && !known.has(project))
  }
  if (consent.leaf === "kinds" && value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).some(
      ([kind, on]) => on === true && before?.kinds[kind] !== true,
    )
  }
  return false
}

/**
 * Whether a write to this leaf must carry `confirm: true`, read from the server's descriptor.
 *
 * `required` asks for the confirmation itself; `widening` asks only when the value actually adds a
 * project or turns a kind on, so narrowing the allowlist is never gated behind a dialog.
 */
export function needsConfirmation(path: string, value: unknown, view: AdaptiveConfigView): boolean {
  const field = writableField(view, path)
  if (!field) return false
  if (field.confirmation === "required") return value === true
  if (field.confirmation === "widening") return widens(path, value, view)
  return false
}

/** A nested patch object for one dotted leaf, the shape `PATCH /harness/adaptive/config` takes. */
export function patchLeaf(path: string, value: unknown): Record<string, unknown> {
  const segments = path.split(".")
  const leaf = segments[segments.length - 1]!
  return segments
    .slice(0, -1)
    .reduceRight<Record<string, unknown>>((inner, key) => ({ [key]: inner }), { [leaf]: value })
}

/** One `422` code said in the reader's words, plus the leaves the server named as missing. */
export type AdaptiveFeedback = { message: string; missing: string[] }

const FEEDBACK: Record<string, string> = {
  "unsupported-field": "This settings surface does not write that field.",
  "invalid-value": "That value is not valid for this setting.",
  "confirmation-required": "This change needs confirmation.",
  "env-disabled": "Disabled by FLUPCODE_ADAPTIVE_DISABLED=1",
  "guard:no-adaptive-token": "This switch needs the acting token, which this server does not have.",
  "guard:egress-allowlist-required": "An egress allowlist is required first.",
  "invalid-config": "The config file is not valid JSON, so it was left alone.",
  "config-unreadable": "The config file could not be read.",
  bad_request: "The server did not understand that request.",
  not_found: "This server does not have that route.",
  invalid_token: "The server refused the request: it needs the loopback token.",
  internal_error: "The server failed while writing the config.",
}

export function feedbackFor(code: string, missing?: string[]): AdaptiveFeedback {
  return { message: FEEDBACK[code] ?? "The change could not be saved.", missing: missing ?? [] }
}

/**
 * Whether the server's last refusal blamed this leaf. The `422` travels `fields`; the panel uses
 * them to highlight the controls it named instead of leaving the reader to guess which one failed.
 */
export function refusedField(error: AdaptiveConfigError | undefined, path: string): boolean {
  return error?.fields?.includes(path) ?? false
}

/** A warning the server travelled beside a successful write, said in the reader's words. */
const WARNINGS: Record<string, string> = {
  "evaluation-gated": "Applying is configured, but promotion waits for the offline evaluation.",
  "runtime-inert": "Configured, but inert on this runtime.",
  "no-model": "There is no model for a draft, so nothing will be written.",
  "skills-still-load": "Learned skills still load from disk.",
  "learning-draft-egress": "Learning drafts are sent, redacted, to the configured small model's provider.",
}

export function warningKey(warning: string): string {
  return WARNINGS[warning] ?? warning
}

/**
 * What the confirmation dialog says before a write. Turning learning on is an egress decision of its
 * own — the draft goes to the small model's provider, not to Jev — so the dialog says what is sent
 * and to whom instead of the generic line.
 */
export function confirmationMessage(path: string, value: unknown, view: AdaptiveConfigView): string {
  const consent = consentPath(path)
  if (consent?.leaf === "enabled" && value === true)
    return t(
      "Consenting to {provider}: redacted, bounded decision inputs for the listed projects and kinds are sent to {provider}. It covers {provider} only, no other provider. The change is written to the config file.",
      { provider: consent.provider },
    )
  if (path !== "learning.enabled" || value !== true)
    return t("Writing to {field} needs confirmation. The change is written to the config file.", { field: path })
  const chars = view.effective.learning.maxInputChars
  const model = view.learningDraft?.model
  if (model)
    return t(
      "Learning drafts a skill from each qualifying session: up to {chars} characters of its objective and evidence, with secrets redacted, are sent through the engine to {model} and its provider. The change is written to the config file.",
      { chars, model },
    )
  return t(
    "Learning drafts a skill from each qualifying session: up to {chars} characters of its objective and evidence, with secrets redacted, are sent through the engine to the configured small model's provider. No model is configured yet, so nothing is sent until one is. The change is written to the config file.",
    { chars },
  )
}

/** Where a leaf's value comes from, as a key for `t`. */
export function sourceKey(provenance: AdaptiveProvenance): string {
  if (provenance === "env") return "from the environment"
  if (provenance === "block") return "from the config file"
  return "default"
}

type PendingConfirm = { path: string; value: unknown; patch: Record<string, unknown> }

/** Everything the panel needs from the cockpit: the view, what health announced, and the outcome. */
export type AdaptiveSettingsState = {
  view?: AdaptiveConfigView
  loading: boolean
  failure?: Error
  /** What `/harness/health` announced: relevance is only offered when the acting line exists. */
  capabilities: string[]
  saving: boolean
  warnings: string[]
  error?: AdaptiveConfigError
}

type AdaptiveSettingsPanelProps = AdaptiveSettingsState & {
  onPatch: (patch: Record<string, unknown>, confirm: boolean) => void
}

/**
 * The adaptive settings (FH-070/FH-074).
 *
 * The kill switch is the master `enabled`: turning it off stops decisions, shadow and Jev, and the
 * panel says plainly that learned skills still load from disk — there is no seam to stop that, so
 * promising it would be a lie. Every control is drawn from the server's `writable` allowlist; a
 * guard that cannot be met disables the control with its reason instead of offering a `422`.
 */
export const AdaptiveSettingsPanel: Component<AdaptiveSettingsPanelProps> = (props) => {
  const [pending, setPending] = createSignal<PendingConfirm>()
  const [budget, setBudget] = createSignal("")

  // The server's budget as last seen, so a write to another switch does not wipe an unsaved draft.
  let serverBudget: string | undefined
  createEffect(() => {
    const view = props.view
    if (!view) return
    const next = String(view.effective.budget.monthlyTokens)
    setBudget((draft) => nextBudgetDraft(draft, serverBudget, next))
    serverBudget = next
  })

  const readOnly = () => !props.view?.canWrite
  // While a write is in flight every control waits: a second click would build its patch from the
  // same stale view the first one did.
  const locked = () => readOnly() || props.saving
  const refused = (path: string) => refusedField(props.error, path)
  const field = (path: string) => (props.view ? writableField(props.view, path) : undefined)
  const problem = (path: string) => {
    const view = props.view
    const entry = field(path)
    return view && entry ? fieldProblem(entry, view, props.capabilities, path) : undefined
  }
  const value = (path: string) => {
    const view = props.view
    if (!view) return false
    const effective = view.effective
    switch (path) {
      case "enabled":
        return effective.enabled
      case "shadow":
        return effective.shadow
      case "context.enabled":
        return effective.context.enabled
      case "context.apply":
        return effective.context.apply
      case "learning.enabled":
        return effective.learning.enabled
      case "relevance.enabled":
        return effective.relevance.enabled
      case "guardrails.enabled":
        return effective.guardrails.enabled
      case "jev.enabled":
        return effective.jev.enabled
      case "retention.enabled":
        return effective.retention.enabled
      default: {
        const consent = consentPath(path)
        return consent?.leaf === "enabled" ? consentOf(view, consent.provider)?.enabled === true : false
      }
    }
  }
  const provenance = (path: string) => {
    const source = props.view?.source[path]
    return source ? t(sourceKey(source)) : ""
  }
  /** Sends a write, opening the dialog first when the server's descriptor asks for a confirmation. */
  const propose = (path: string, next: unknown) => {
    const view = props.view
    if (!view || locked()) return
    const patch = patchLeaf(path, next)
    if (needsConfirmation(path, next, view)) {
      setPending({ path, value: next, patch })
      return
    }
    props.onPatch(patch, false)
  }
  /** One boolean row, drawn only when the server lists its leaf as writable. */
  const Switch = (row: {
    path: string
    label: string
    params?: Record<string, string | number>
    children?: JSX.Element
  }) => (
    <Show when={field(row.path)}>
      <div class="fc-settings-row" classList={{ "fc-settings-refused": refused(row.path) }}>
        <span class="fc-settings-usage">
          <span>{t(row.label, row.params)}</span>
          {row.children}
          <Show when={problem(row.path)}>
            {(reason) => <span class="fc-settings-hint">{t(problemKey(reason()))}</span>}
          </Show>
          <Show when={props.view && inactiveByMaster(props.view, row.path)}>
            <span class="fc-settings-hint">{t("Inactive: the master switch is off.")}</span>
          </Show>
        </span>
        <Toggle
          checked={value(row.path)}
          label={t(row.label, row.params)}
          disabled={locked() || !!problem(row.path)}
          onToggle={() => propose(row.path, !value(row.path))}
        />
      </div>
    </Show>
  )

  /**
   * One remote provider's consent: its switch, the projects and the kinds it may receive. Each row
   * names the provider, and consenting to one never covers another.
   */
  const ProviderConsent = (row: { provider: string }) => {
    const [project, setProject] = createSignal("")
    const path = (leaf: string) => `egress.providers.${row.provider}.${leaf}`
    const projects = () => (props.view ? consentOf(props.view, row.provider)?.projects : undefined) ?? []
    const kinds = () => (props.view ? consentOf(props.view, row.provider)?.kinds : undefined) ?? {}
    return (
      <>
        <Show when={field(path("enabled")) || field(path("projects")) || field(path("kinds"))}>
          <div class="fc-settings-subtitle">{t("Egress consent: {provider}", { provider: row.provider })}</div>
        </Show>
        <Switch path={path("enabled")} label="Send data to {provider}" params={{ provider: row.provider }}>
          <span class="fc-settings-hint">
            {t("Needs confirmation. Covers {provider} only.", { provider: row.provider })}
          </span>
        </Switch>
        <Show when={field(path("projects"))}>
          <Show
            when={projects().length > 0}
            fallback={<div class="fc-settings-hint">{t("No projects allowed yet.")}</div>}
          >
            <For each={projects()}>
              {(allowed) => (
                <div class="fc-usage-row" classList={{ "fc-settings-refused": refused(path("projects")) }}>
                  <span class="fc-usage-key" dir="auto" title={allowed}>
                    {allowed}
                  </span>
                  <Show when={!readOnly()}>
                    <button
                      class="fc-button"
                      type="button"
                      disabled={locked()}
                      onClick={() =>
                        propose(
                          path("projects"),
                          projects().filter((entry) => entry !== allowed),
                        )
                      }
                    >
                      {t("Remove")}
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </Show>
          <Show when={!readOnly()}>
            <div class="fc-field-row" classList={{ "fc-settings-refused": refused(path("projects")) }}>
              <label class="fc-field">
                <span>{t("Project path for {provider}", { provider: row.provider })}</span>
                <input
                  class="fc-question-custom"
                  dir="ltr"
                  value={project()}
                  onInput={(event) => setProject(event.currentTarget.value)}
                />
              </label>
              <button
                class="fc-button"
                type="button"
                disabled={locked() || !project().trim()}
                onClick={() => {
                  propose(path("projects"), [...projects(), project().trim()])
                  setProject("")
                }}
              >
                {t("Add project")}
              </button>
            </div>
          </Show>
        </Show>
        <Show when={field(path("kinds"))}>
          <For each={ADAPTIVE_KINDS}>
            {(kind) => (
              <div class="fc-settings-row" classList={{ "fc-settings-refused": refused(path("kinds")) }}>
                <span class="fc-usage-key" dir="ltr">
                  {kind}
                </span>
                <Toggle
                  checked={kinds()[kind] === true}
                  label={t("{kind} for {provider}", { kind, provider: row.provider })}
                  disabled={locked()}
                  onToggle={() => propose(path("kinds"), { ...kinds(), [kind]: kinds()[kind] !== true })}
                />
              </div>
            )}
          </For>
        </Show>
      </>
    )
  }

  return (
    <section class="fc-settings-section" aria-label={t("Adaptive")}>
      <h3 class="fc-settings-title">{t("Adaptive")}</h3>

      <Show
        when={props.view}
        fallback={
          <p class="fc-usage-note">
            {!adaptiveSurfaces(props.capabilities).config
              ? t("This server does not have the adaptive settings.")
              : props.loading
                ? t("Reading…")
                : props.failure instanceof Error
                  ? props.failure.message
                  : t("The harness server did not answer.")}
          </p>
        }
      >
        {(view) => (
          <>
            <Show when={readOnly()}>
              <div class="fc-routines-notice">{t("Read-only: this server has no writer token.")}</div>
            </Show>

            {/* The kill switch (FH-074). The copy never promises more than the engine can do. */}
            <Show when={field("enabled")}>
              <div
                class="fc-settings-row fc-settings-highlight"
                classList={{ "fc-settings-refused": refused("enabled") }}
              >
                <span class="fc-settings-usage">
                  <span>{t("Adaptive decisions")}</span>
                  <span class="fc-settings-hint">
                    {t("Turning this off stops decisions, shadow and Jev. Learned skills still load from disk.")}
                  </span>
                  <Show when={view().env.adaptiveDisabled}>
                    <span class="fc-settings-hint">{t("Disabled by FLUPCODE_ADAPTIVE_DISABLED=1")}</span>
                  </Show>
                </span>
                <Toggle
                  checked={value("enabled")}
                  label={t("Adaptive decisions")}
                  disabled={locked() || view().env.adaptiveDisabled}
                  onToggle={() => propose("enabled", !value("enabled"))}
                />
              </div>
              <div class="fc-settings-hint">
                {t("Effective value")}: {value("enabled") ? t("On") : t("Off")} · {provenance("enabled")}
              </div>
            </Show>

            <Switch path="shadow" label="Shadow">
              <span class="fc-settings-hint">{t("Records decisions without acting on them.")}</span>
            </Switch>
            <Switch path="context.enabled" label="Context selection">
              <span class="fc-settings-hint">{provenance("context.enabled")}</span>
            </Switch>
            <Switch path="context.apply" label="Apply the context plan">
              <span class="fc-settings-hint">{t("Promotion waits for the offline evaluation.")}</span>
            </Switch>
            <Switch path="learning.enabled" label="Learning">
              <span class="fc-settings-hint">
                {view().learningDraft?.model
                  ? t("Needs confirmation. Drafts are sent to {model}.", { model: view().learningDraft!.model! })
                  : t("Needs confirmation.")}
              </span>
            </Switch>
            <Switch path="relevance.enabled" label="Relevance" />
            <Switch path="guardrails.enabled" label="Loop warnings">
              <span class="fc-settings-hint">
                {t("Warns when the agent repeats the same tool call; never pauses the turn.")}
              </span>
            </Switch>
            <Switch path="jev.enabled" label="Jev">
              <span class="fc-settings-hint">{t("Needs confirmation.")}</span>
              <Show when={!view().env.typesafeKeyPresent}>
                <span class="fc-settings-hint">{t("Key missing: decisions fall back to built-in rules.")}</span>
              </Show>
            </Switch>
            <Switch path="retention.enabled" label="Retention">
              <span class="fc-settings-hint">{t("Needs confirmation.")}</span>
            </Switch>

            {/* Egress: what may leave the machine, provider by provider (AH-C03). */}
            <For each={consentProviders(view())}>{(provider) => <ProviderConsent provider={provider} />}</For>

            <Show when={field("budget.monthlyTokens")}>
              <div class="fc-settings-row" classList={{ "fc-settings-refused": refused("budget.monthlyTokens") }}>
                <span class="fc-settings-usage">
                  <span>{t("Monthly token budget")}</span>
                  <span class="fc-settings-hint">
                    {t("Spent {spent} of {cap} this month.", {
                      spent: view().usage.tokensSpent,
                      cap: view().usage.monthlyTokens,
                    })}
                  </span>
                </span>
                <span class="fc-settings-actions">
                  <input
                    class="fc-question-custom"
                    dir="ltr"
                    inputmode="numeric"
                    value={budget()}
                    onInput={(event) => setBudget(event.currentTarget.value)}
                  />
                  <button
                    class="fc-button"
                    type="button"
                    disabled={locked() || !(Number(budget()) > 0)}
                    onClick={() => propose("budget.monthlyTokens", Number(budget()))}
                  >
                    {t("Save")}
                  </button>
                </span>
              </div>
            </Show>

            <Show when={props.warnings.length > 0}>
              <For each={props.warnings}>
                {(warning) => <div class="fc-settings-hint">{t(warningKey(warning))}</div>}
              </For>
            </Show>
            <Show when={props.error}>
              {(failure) => {
                const feedback = () => feedbackFor(failure().code, failure().missing)
                return (
                  <>
                    <p class="fc-run-error">{t(feedback().message)}</p>
                    <Show when={(failure().fields?.length ?? 0) > 0}>
                      <p class="fc-settings-hint">
                        {t("Refused fields: {fields}", { fields: (failure().fields ?? []).join(", ") })}
                      </p>
                    </Show>
                    <Show when={feedback().missing.length > 0}>
                      <p class="fc-settings-hint">
                        {t("Missing: {fields}", { fields: feedback().missing.join(", ") })}
                      </p>
                    </Show>
                  </>
                )
              }}
            </Show>

            <div class="fc-settings-hint">
              {t("Config file")}: <bdi dir="ltr">{view().writer.path}</bdi>{" "}
              {view().writer.exists ? "" : t("(not created yet)")}
            </div>
          </>
        )}
      </Show>

      <ConfirmDialog
        open={!!pending()}
        title={t("Confirm change")}
        message={
          pending() && props.view ? confirmationMessage(pending()!.path, pending()!.value, props.view) : ""
        }
        confirmLabel={t("Write it")}
        onConfirm={() => {
          const next = pending()
          setPending(undefined)
          if (next) props.onPatch(next.patch, true)
        }}
        onClose={() => setPending(undefined)}
      />
    </section>
  )
}
