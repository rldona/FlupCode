import { For, Show, createSignal, type Component } from "solid-js"
import { t } from "../i18n"

export type PermissionAction = "ask" | "allow" | "deny"

/** The keys the engine names explicitly and the ones this form can set to a plain action. */
export const PERMISSION_KEYS = [
  "*",
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "lsp",
  "doom_loop",
  "skill",
] as const

const ACTIONS: PermissionAction[] = ["ask", "allow", "deny"]

const isAction = (value: unknown): value is PermissionAction =>
  value === "ask" || value === "allow" || value === "deny"

/** One pattern rule: `bash: { "rm -rf *": "deny" }` is `{ tool: "bash", pattern: "rm -rf *", action: "deny" }`. */
export type PatternRule = { tool: string; pattern: string; action: PermissionAction }

/** Tools a pattern rule can name. `*` takes no patterns: it is the plain action above. */
const RULE_TOOLS = PERMISSION_KEYS.filter((key) => key !== "*")

/**
 * The engine's `permission` as the form can hold it.
 *
 * A key with a plain action is a per-tool default; a key with a map of pattern→action is a list
 * of editable rules; anything else is kept aside and written back untouched.
 */
export function normalizePolicy(raw: unknown): {
  actions: Record<string, PermissionAction>
  rules: PatternRule[]
  other: Record<string, unknown>
} {
  if (typeof raw === "string") return { actions: isAction(raw) ? { "*": raw } : {}, rules: [], other: {} }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { actions: {}, rules: [], other: {} }
  const actions: Record<string, PermissionAction> = {}
  const rules: PatternRule[] = []
  const other: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (isAction(value)) {
      actions[key] = value
      continue
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value)
      // A map is rules only if every pattern has a plain action; anything mixed stays aside.
      if (entries.length > 0 && entries.every(([, action]) => isAction(action))) {
        for (const [pattern, action] of entries) rules.push({ tool: key, pattern, action: action as PermissionAction })
        continue
      }
    }
    other[key] = value
  }
  return { actions, rules, other }
}

/**
 * The action map and the pattern rules on top of the keys kept aside. A key set back to
 * default is dropped, and a tool left with no rules loses its map.
 */
export function mergePolicy(
  actions: Record<string, PermissionAction | undefined>,
  rules: PatternRule[],
  other: Record<string, unknown>,
) {
  const merged: Record<string, unknown> = { ...other }
  for (const [key, value] of Object.entries(actions)) {
    if (value) merged[key] = value
  }
  const byTool = new Map<string, Record<string, PermissionAction>>()
  for (const rule of rules) {
    const pattern = rule.pattern.trim()
    if (!rule.tool || !pattern) continue
    if (!byTool.has(rule.tool)) byTool.set(rule.tool, {})
    byTool.get(rule.tool)![pattern] = rule.action
  }
  for (const [tool, map] of byTool) merged[tool] = map
  return merged
}

type PermissionsPanelProps = {
  /** The engine's `permission`, as it is on disk. */
  policy: unknown
  /** Permissions granted with "Allow always", which are runtime and not part of the policy. */
  savedPermissions: Array<{ id: string; action: string; resource: string }>
  onRevokePermission: (id: string) => void
  onSave: (policy: Record<string, unknown>) => void
  /** The engine is the only one who can write this; without it, the form is read-only. */
  serverAvailable: boolean
}

export const PermissionsPanel: Component<PermissionsPanelProps> = (props) => {
  const [draft, setDraft] = createSignal<Record<string, PermissionAction | undefined>>()
  const [draftRules, setDraftRules] = createSignal<PatternRule[]>()
  const [newTool, setNewTool] = createSignal("bash")
  const [newPattern, setNewPattern] = createSignal("")
  const [newAction, setNewAction] = createSignal<PermissionAction>("deny")
  const [saved, setSaved] = createSignal(false)

  const normal = () => normalizePolicy(props.policy)
  const current = () => draft() ?? normal().actions
  const rules = () => draftRules() ?? normal().rules
  const other = () => normal().other

  const touch = () => setSaved(false)
  const set = (key: string, value: string) => {
    touch()
    setDraft({ ...current(), [key]: value === "" ? undefined : (value as PermissionAction) })
  }
  const setRules = (next: PatternRule[]) => {
    touch()
    setDraftRules(next)
  }

  const save = () => {
    props.onSave(mergePolicy(current(), rules(), other()))
    setSaved(true)
  }

  // `external_directory` only ever restricts: the engine asks at minimum, so `allow` is not offered.
  const actionsFor = (key: string): PermissionAction[] =>
    key === "external_directory" ? ["ask", "deny"] : ACTIONS

  return (
    <div class="fc-permissions-editor">
      <p class="fc-settings-note">
        {t("The engine asks by default. A rule per tool, and `*` for the rest.")}
      </p>
      <Show when={props.serverAvailable} fallback={<p class="fc-settings-hint">{t("Editing the policy needs the engine running.")}</p>}>
        <For each={PERMISSION_KEYS}>
          {(key) => (
            <label class="fc-settings-row">
              <span>{key === "*" ? t("Everything else") : key}</span>
              <select
                class="fc-toolbar-select"
                value={current()[key] ?? ""}
                onChange={(event) => set(key, event.currentTarget.value)}
              >
                <option value="">{t("Default")}</option>
                <For each={actionsFor(key)}>{(action) => <option value={action}>{t(action)}</option>}</For>
              </select>
            </label>
          )}
        </For>

        <div class="fc-settings-section">
          <h3 class="fc-settings-title">{t("Rules by pattern")}</h3>
          <p class="fc-settings-hint">
            {t("A pattern narrows a tool: `bash` with `rm -rf *` denied. First match in file order wins.")}
          </p>
          <ul class="fc-saved-permissions">
            <For each={rules()}>
              {(rule, index) => (
                <li class="fc-settings-row">
                  <select
                    class="fc-toolbar-select"
                    aria-label={t("Tool")}
                    value={rule.tool}
                    onChange={(event) =>
                      setRules(rules().map((entry, at) => (at === index() ? { ...entry, tool: event.currentTarget.value } : entry)))
                    }
                  >
                    <For each={RULE_TOOLS}>{(tool) => <option value={tool}>{tool}</option>}</For>
                  </select>
                  <input
                    class="fc-question-custom"
                    aria-label={t("Pattern")}
                    value={rule.pattern}
                    placeholder="rm -rf *"
                    onInput={(event) =>
                      setRules(rules().map((entry, at) => (at === index() ? { ...entry, pattern: event.currentTarget.value } : entry)))
                    }
                  />
                  <select
                    class="fc-toolbar-select"
                    aria-label={t("Action")}
                    value={rule.action}
                    onChange={(event) =>
                      setRules(
                        rules().map((entry, at) =>
                          at === index() ? { ...entry, action: event.currentTarget.value as PermissionAction } : entry,
                        ),
                      )
                    }
                  >
                    <For each={ACTIONS}>{(action) => <option value={action}>{t(action)}</option>}</For>
                  </select>
                  <button
                    class="fc-button"
                    type="button"
                    aria-label={t("Delete rule")}
                    onClick={() => setRules(rules().filter((_, at) => at !== index()))}
                  >
                    ×
                  </button>
                </li>
              )}
            </For>
          </ul>
          <div class="fc-settings-row">
            <select
              class="fc-toolbar-select"
              aria-label={t("Tool")}
              value={newTool()}
              onChange={(event) => setNewTool(event.currentTarget.value)}
            >
              <For each={RULE_TOOLS}>{(tool) => <option value={tool}>{tool}</option>}</For>
            </select>
            <input
              class="fc-question-custom"
              aria-label={t("Pattern")}
              value={newPattern()}
              placeholder="rm -rf *"
              onInput={(event) => setNewPattern(event.currentTarget.value)}
            />
            <select
              class="fc-toolbar-select"
              aria-label={t("Action")}
              value={newAction()}
              onChange={(event) => setNewAction(event.currentTarget.value as PermissionAction)}
            >
              <For each={ACTIONS}>{(action) => <option value={action}>{t(action)}</option>}</For>
            </select>
            <button
              class="fc-button"
              type="button"
              disabled={!newPattern().trim()}
              onClick={() => {
                setRules([...rules(), { tool: newTool(), pattern: newPattern().trim(), action: newAction() }])
                setNewPattern("")
              }}
            >
              {t("Add")}
            </button>
          </div>
        </div>

        <Show when={Object.keys(other()).length > 0}>
          <div class="fc-settings-section">
            <h3 class="fc-settings-title">{t("Kept as they are")}</h3>
            <p class="fc-settings-hint">
              {t("Shapes the form does not understand, written back untouched.")}
            </p>
            <ul class="fc-saved-permissions">
              <For each={Object.entries(other())}>
                {([key, value]) => (
                  <li class="fc-settings-row">
                    <span>
                      <code>{key}</code>
                    </span>
                    <code class="fc-permission-pattern">{JSON.stringify(value)}</code>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>

        <div class="fc-settings-actions">
          <button class="fc-button fc-button-primary" type="button" onClick={save}>
            {saved() ? t("Saved") : t("Save")}
          </button>
        </div>
      </Show>

      <div class="fc-settings-section">
        <h3 class="fc-settings-title">{t("Remembered permissions")}</h3>
        {/* "Allow always" wrote these and nothing ever showed them again, so a grant made once
            in one session kept applying everywhere with no way to take it back. */}
        <Show
          when={props.savedPermissions.length > 0}
          fallback={<p class="fc-settings-hint">{t("Nothing is allowed always")}</p>}
        >
          <ul class="fc-saved-permissions">
            <For each={props.savedPermissions}>
              {(entry) => (
                <li class="fc-settings-row">
                  <span>
                    <code>{entry.action}</code> · <code>{entry.resource}</code>
                  </span>
                  <button class="fc-button" type="button" onClick={() => props.onRevokePermission(entry.id)}>
                    {t("Revoke")}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  )
}
