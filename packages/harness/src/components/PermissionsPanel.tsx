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

/**
 * The engine's `permission` as the form can hold it.
 *
 * A key whose value is a plain action is editable; a key whose value is a **map of patterns** —
 * `bash: { "rm -rf *": "deny" }`, which is how precedence is expressed — is kept aside and written
 * back untouched. A form that flattened it would silently drop the rules that matter most.
 */
export function normalizePolicy(raw: unknown): { actions: Record<string, PermissionAction>; other: Record<string, unknown> } {
  if (typeof raw === "string") return { actions: isAction(raw) ? { "*": raw } : {}, other: {} }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { actions: {}, other: {} }
  const actions: Record<string, PermissionAction> = {}
  const other: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (isAction(value)) actions[key] = value
    else other[key] = value
  }
  return { actions, other }
}

/** The action map on top of the keys that were kept aside. A key set back to default is dropped. */
export function mergePolicy(actions: Record<string, PermissionAction | undefined>, other: Record<string, unknown>) {
  const merged: Record<string, unknown> = { ...other }
  for (const [key, value] of Object.entries(actions)) {
    if (value) merged[key] = value
  }
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
  const [saved, setSaved] = createSignal(false)

  const normal = () => normalizePolicy(props.policy)
  const current = () => draft() ?? normal().actions
  const other = () => normal().other

  const set = (key: string, value: string) => {
    setSaved(false)
    setDraft({ ...current(), [key]: value === "" ? undefined : (value as PermissionAction) })
  }

  const save = () => {
    props.onSave(mergePolicy(current(), other()))
    setSaved(true)
  }

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
                <For each={ACTIONS}>{(action) => <option value={action}>{t(action)}</option>}</For>
              </select>
            </label>
          )}
        </For>

        <Show when={Object.keys(other()).length > 0}>
          <div class="fc-settings-section">
            <h3 class="fc-settings-title">{t("Rules by pattern")}</h3>
            {/* These are maps, not actions: `bash: { "rm -rf *": "deny" }`. The form does not edit
                them, and it does not drop them either. */}
            <p class="fc-settings-hint">
              {t("Kept as they are. Pattern rules are edited in the advanced configuration.")}
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
