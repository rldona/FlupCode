import { For, Show, createEffect, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { adaptiveSurfaces } from "../client"
import type { AdaptiveConfigError } from "../client"
import type {
  AdaptiveConfigView,
  AdaptiveProvenance,
  AdaptiveWritableField,
} from "../types"
import { Toggle } from "./Toggle"
import { ConfirmDialog } from "./ConfirmDialog"

/** The decision kinds E8 shows when editing the egress allowlist: the four the server ships. */
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
  return view.writable.find((field) => field.path === path)
}

/**
 * Whether a field's guard can be met right now.
 *
 * The server evaluates the guards on the effective config *after* the patch, so this mirrors the
 * parts a single switch cannot change: the environment, the acting token (announced by the
 * `adaptive-relevance` capability) and the egress allowlist the switch itself needs. A switch whose
 * guard already fails is drawn disabled with the reason, never as a control that would only 422.
 */
export function fieldProblem(
  field: AdaptiveWritableField,
  view: AdaptiveConfigView,
  capabilities: readonly string[],
): AdaptiveProblem | undefined {
  if (field.guard === "env-disabled" && view.env.adaptiveDisabled) return "env-disabled"
  if (field.guard === "adaptive-token" && !capabilities.includes("adaptive-relevance")) return "no-adaptive-token"
  if (field.guard === "egress-allowlist") {
    const projects = view.effective.egress.projects
    const kinds = view.effective.egress.kinds
    if (field.path === "learning.enabled") {
      if (projects.length === 0 || kinds.skillReflection !== true) return "egress-allowlist"
    } else if (projects.length === 0 || !Object.values(kinds).some(Boolean)) return "egress-allowlist"
  }
  return undefined
}

/** The reason a guard shows, as an i18n key; undefined when the guard is satisfied. */
export function problemKey(problem: AdaptiveProblem): string {
  if (problem === "env-disabled") return "Disabled by FLUPCODE_ADAPTIVE_DISABLED=1"
  if (problem === "no-adaptive-token") return "Relevance needs the acting token, which this server does not have."
  return "Enabling this needs a project and a kind in the egress allowlist first."
}

/** Whether a value widens the egress allowlist, which the server only writes with `confirm: true`. */
function widens(path: string, value: unknown, view: AdaptiveConfigView): boolean {
  if (path === "egress.projects" && Array.isArray(value)) {
    const before = new Set(view.effective.egress.projects)
    return value.some((project) => typeof project === "string" && !before.has(project))
  }
  if (path === "egress.kinds" && value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).some(
      ([kind, on]) => on === true && view.effective.egress.kinds[kind] !== true,
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
export function needsConfirmation(
  path: string,
  value: unknown,
  view: AdaptiveConfigView,
): boolean {
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
  "guard:no-adaptive-token": "Relevance needs the acting token, which this server does not have.",
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
}

export function warningKey(warning: string): string {
  return WARNINGS[warning] ?? warning
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
  const [project, setProject] = createSignal("")
  const [budget, setBudget] = createSignal("")

  createEffect(() => {
    const view = props.view
    if (view) setBudget(String(view.effective.budget.monthlyTokens))
  })

  const readOnly = () => !props.view?.canWrite
  const refused = (path: string) => refusedField(props.error, path)
  const field = (path: string) => (props.view ? writableField(props.view, path) : undefined)
  const problem = (path: string) => {
    const view = props.view
    const entry = field(path)
    return view && entry ? fieldProblem(entry, view, props.capabilities) : undefined
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
      case "jev.enabled":
        return effective.jev.enabled
      case "retention.enabled":
        return effective.retention.enabled
      default:
        return false
    }
  }
  const provenance = (path: string) => {
    const source = props.view?.source[path]
    return source ? t(sourceKey(source)) : ""
  }
  /** Sends a write, opening the dialog first when the server's descriptor asks for a confirmation. */
  const propose = (path: string, next: unknown) => {
    const view = props.view
    if (!view || readOnly()) return
    const patch = patchLeaf(path, next)
    if (needsConfirmation(path, next, view)) {
      setPending({ path, value: next, patch })
      return
    }
    props.onPatch(patch, false)
  }
  const problemToggle = (path: string) => {
    const reason = problem(path)
    return reason ? { disabled: true, reason } : undefined
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
            <div class="fc-settings-row fc-settings-highlight" classList={{ "fc-settings-refused": refused("enabled") }}>
              <span class="fc-settings-usage">
                <span>{t("Adaptive decisions")}</span>
                <span class="fc-settings-hint">
                  {t("Turning this off stops decisions, shadow and Jev. Learned skills still load from disk.")}
                </span>
                <Show when={props.view?.env.adaptiveDisabled}>
                  <span class="fc-settings-hint">{t("Disabled by FLUPCODE_ADAPTIVE_DISABLED=1")}</span>
                </Show>
              </span>
              <Toggle
                checked={value("enabled")}
                label={t("Adaptive decisions")}
                disabled={readOnly() || props.view?.env.adaptiveDisabled === true}
                onToggle={() => propose("enabled", !value("enabled"))}
              />
            </div>
            <div class="fc-settings-hint">
              {t("Effective value")}: {value("enabled") ? t("On") : t("Off")} · {provenance("enabled")}
            </div>

            <div class="fc-settings-row" classList={{ "fc-settings-refused": refused("shadow") }}>
              <span class="fc-settings-usage">
                <span>{t("Shadow")}</span>
                <span class="fc-settings-hint">{t("Records decisions without acting on them.")}</span>
              </span>
              <Toggle
                checked={value("shadow")}
                label={t("Shadow")}
                disabled={readOnly()}
                onToggle={() => propose("shadow", !value("shadow"))}
              />
            </div>

            <div class="fc-settings-row" classList={{ "fc-settings-refused": refused("context.enabled") }}>
              <span class="fc-settings-usage">
                <span>{t("Context selection")}</span>
                <span class="fc-settings-hint">{provenance("context.enabled")}</span>
              </span>
              <Toggle
                checked={value("context.enabled")}
                label={t("Context selection")}
                disabled={readOnly()}
                onToggle={() => propose("context.enabled", !value("context.enabled"))}
              />
            </div>

            <div class="fc-settings-row" classList={{ "fc-settings-refused": refused("context.apply") }}>
              <span class="fc-settings-usage">
                <span>{t("Apply the context plan")}</span>
                <span class="fc-settings-hint">{t("Promotion waits for the offline evaluation.")}</span>
              </span>
              <Toggle
                checked={value("context.apply")}
                label={t("Apply the context plan")}
                disabled={readOnly()}
                onToggle={() => propose("context.apply", !value("context.apply"))}
              />
            </div>

            <div class="fc-settings-row" classList={{ "fc-settings-refused": refused("learning.enabled") }}>
              <span class="fc-settings-usage">
                <span>{t("Learning")}</span>
                <Show when={problem("learning.enabled")}>
                  {(reason) => <span class="fc-settings-hint">{t(problemKey(reason()))}</span>}
                </Show>
              </span>
              <Toggle
                checked={value("learning.enabled")}
                label={t("Learning")}
                disabled={readOnly() || !!problemToggle("learning.enabled")}
                onToggle={() => propose("learning.enabled", !value("learning.enabled"))}
              />
            </div>

            <div class="fc-settings-row" classList={{ "fc-settings-refused": refused("relevance.enabled") }}>
              <span class="fc-settings-usage">
                <span>{t("Relevance")}</span>
                <Show when={problem("relevance.enabled")}>
                  {(reason) => <span class="fc-settings-hint">{t(problemKey(reason()))}</span>}
                </Show>
              </span>
              <Toggle
                checked={value("relevance.enabled")}
                label={t("Relevance")}
                disabled={readOnly() || !!problemToggle("relevance.enabled")}
                onToggle={() => propose("relevance.enabled", !value("relevance.enabled"))}
              />
            </div>

            <div class="fc-settings-row" classList={{ "fc-settings-refused": refused("jev.enabled") }}>
              <span class="fc-settings-usage">
                <span>{t("Jev")}</span>
                <span class="fc-settings-hint">{t("Needs confirmation.")}</span>
                <Show when={problem("jev.enabled")}>
                  {(reason) => <span class="fc-settings-hint">{t(problemKey(reason()))}</span>}
                </Show>
              </span>
              <Toggle
                checked={value("jev.enabled")}
                label={t("Jev")}
                disabled={readOnly() || !!problemToggle("jev.enabled")}
                onToggle={() => propose("jev.enabled", !value("jev.enabled"))}
              />
            </div>

            <div class="fc-settings-row" classList={{ "fc-settings-refused": refused("retention.enabled") }}>
              <span class="fc-settings-usage">
                <span>{t("Retention")}</span>
                <span class="fc-settings-hint">{t("Needs confirmation.")}</span>
              </span>
              <Toggle
                checked={value("retention.enabled")}
                label={t("Retention")}
                disabled={readOnly()}
                onToggle={() => propose("retention.enabled", !value("retention.enabled"))}
              />
            </div>

            {/* Egress: what may leave the machine, project by project and kind by kind. */}
            <div class="fc-settings-subtitle">{t("Egress allowlist")}</div>
            <Show
              when={view().effective.egress.projects.length > 0}
              fallback={<div class="fc-settings-hint">{t("No projects allowed yet.")}</div>}
            >
              <For each={view().effective.egress.projects}>
                {(allowed) => (
                  <div class="fc-usage-row" classList={{ "fc-settings-refused": refused("egress.projects") }}>
                    <span class="fc-usage-key" dir="auto" title={allowed}>
                      {allowed}
                    </span>
                    <Show when={!readOnly()}>
                      <button
                        class="fc-button"
                        type="button"
                        onClick={() =>
                          propose(
                            "egress.projects",
                            view().effective.egress.projects.filter((entry) => entry !== allowed),
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
              <div class="fc-field-row" classList={{ "fc-settings-refused": refused("egress.projects") }}>
                <label class="fc-field">
                  <span>{t("Project path")}</span>
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
                  disabled={!project().trim()}
                  onClick={() => {
                    propose("egress.projects", [...view().effective.egress.projects, project().trim()])
                    setProject("")
                  }}
                >
                  {t("Add project")}
                </button>
              </div>
            </Show>

            <For each={ADAPTIVE_KINDS}>
              {(kind) => (
                <div class="fc-settings-row" classList={{ "fc-settings-refused": refused("egress.kinds") }}>
                  <span class="fc-usage-key" dir="ltr">
                    {kind}
                  </span>
                  <Toggle
                    checked={view().effective.egress.kinds[kind] === true}
                    label={kind}
                    disabled={readOnly()}
                    onToggle={() =>
                      propose("egress.kinds", {
                        ...view().effective.egress.kinds,
                        [kind]: view().effective.egress.kinds[kind] !== true,
                      })
                    }
                  />
                </div>
              )}
            </For>

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
                  disabled={readOnly() || !(Number(budget()) > 0)}
                  onClick={() => propose("budget.monthlyTokens", Number(budget()))}
                >
                  {t("Save")}
                </button>
              </span>
            </div>

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
                      <p class="fc-settings-hint">{t("Missing: {fields}", { fields: feedback().missing.join(", ") })}</p>
                    </Show>
                  </>
                )
              }}
            </Show>

            <div class="fc-settings-hint">
              {t("Config file")}:{" "}
              <bdi dir="ltr">{view().writer.path}</bdi> {view().writer.exists ? "" : t("(not created yet)")}
            </div>
          </>
        )}
      </Show>

      <ConfirmDialog
        open={!!pending()}
        title={t("Confirm change")}
        message={
          pending()
            ? t("Writing to {field} needs confirmation. The change is written to the config file.", {
                field: pending()!.path,
              })
            : ""
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
