import { For, Show, createEffect, createMemo, createSignal, on, type Component } from "solid-js"
import type { ModelInfo } from "../engine-types"
import { t } from "../i18n"
import { groupedModels, isDeprecated, modelKey } from "../model-catalog"

/** What the dialog asks for: a task, the models to try it on, and whether each attempt gets its tree. */
export type BestOfNLaunch = {
  prompt: string
  models: string[]
  worktrees: boolean
}

type BestOfNDialogProps = {
  open: boolean
  models: ModelInfo[]
  loading?: boolean
  /** Kept in the same order as the single-model picker, so the two cannot disagree. */
  favorites: string[]
  onLaunch: (launch: BestOfNLaunch) => void
  onClose: () => void
}

/**
 * One task, several models (H-44).
 *
 * Not a workflow and not a run of N tasks: each model gets its own run, because what is compared is
 * a run — what it cost, how long it took, what it touched — and H-33's screen already reads runs.
 * The dialog only asks for what the server cannot guess: the task, and which models to try.
 */
export const BestOfNDialog: Component<BestOfNDialogProps> = (props) => {
  const [prompt, setPrompt] = createSignal("")
  const [selected, setSelected] = createSignal<string[]>([])
  const [worktrees, setWorktrees] = createSignal(true)
  const [query, setQuery] = createSignal("")

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        setPrompt("")
        setSelected([])
        setWorktrees(true)
        setQuery("")
      },
    ),
  )

  const groups = createMemo(() => groupedModels(props.models, query(), props.favorites))
  const toggle = (key: string, on: boolean) =>
    setSelected((current) => (on ? [...current, key] : current.filter((entry) => entry !== key)))
  // One model is not a comparison: there would be nothing to put side by side.
  const ready = () => prompt().trim().length > 0 && selected().length >= 2

  const launch = () => {
    if (!ready()) return
    props.onLaunch({ prompt: prompt().trim(), models: selected(), worktrees: worktrees() })
  }

  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div
          class="fc-modal fc-launch-modal"
          role="dialog"
          aria-modal="true"
          aria-label={t("Best of N")}
          onClick={(event) => event.stopPropagation()}
        >
          <div class="fc-modal-header">
            <span>{t("Best of N")}</span>
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
              ×
            </button>
          </div>

          <p class="fc-usage-note">
            {t("The same task on several models, each in its own run, then compare what they did.")}
          </p>

          <label class="fc-field">
            <span>{t("Task")}</span>
            <textarea
              class="fc-input fc-launch-textarea"
              value={prompt()}
              placeholder={t("What should each model do?")}
              onInput={(event) => setPrompt(event.currentTarget.value)}
            />
          </label>

          <div class="fc-field">
            <span>{t("Models")}</span>
            <Show when={selected().length > 0}>
              <div class="fc-launch-packs">
                <For each={selected()}>
                  {(key) => (
                    <button
                      class="fc-button"
                      type="button"
                      aria-label={t("Remove {name}", { name: key })}
                      onClick={() => toggle(key, false)}
                    >
                      {key} ×
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show when={selected().length === 1}>
              <p class="fc-usage-note">{t("Pick one more: a comparison needs two.")}</p>
            </Show>
            <input
              class="fc-question-custom"
              value={query()}
              placeholder={t("Search models")}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
            <Show
              when={props.models.length > 0}
              fallback={
                <p class="fc-palette-empty">{props.loading ? t("Loading models…") : t("No models")}</p>
              }
            >
              <div class="fc-model-picker">
                <For each={groups()}>
                  {(group) => (
                    <div class="fc-model-group">
                      <div class="fc-model-group-label">{group.providerID}</div>
                      <ul>
                        <For each={group.items}>
                          {(model) => {
                            const key = modelKey(model)
                            return (
                              <li class="fc-model-row" classList={{ "fc-model-row-active": selected().includes(key) }}>
                                <label class="fc-model-main">
                                  <span class="fc-model-title">
                                    <input
                                      type="checkbox"
                                      checked={selected().includes(key)}
                                      onChange={(event) => toggle(key, event.currentTarget.checked)}
                                    />
                                    <span class="fc-model-name">{model.name}</span>
                                    <Show when={isDeprecated(model)}>
                                      <span class="fc-model-badge">{t("Deprecated")}</span>
                                    </Show>
                                  </span>
                                  <span class="fc-model-id">{model.id}</span>
                                </label>
                              </li>
                            )
                          }}
                        </For>
                      </ul>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>

          <label class="fc-field-row">
            <input type="checkbox" checked={worktrees()} onChange={(event) => setWorktrees(event.currentTarget.checked)} />
            <span>{t("A worktree per attempt")}</span>
          </label>

          <div class="fc-dialog-actions">
            <button class="fc-button" type="button" onClick={props.onClose}>
              {t("Cancel")}
            </button>
            <button class="fc-button fc-button-primary" type="button" disabled={!ready()} onClick={launch}>
              {t("Run")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
