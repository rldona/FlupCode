import { For, Show, createSignal, type Component } from "solid-js"
import type { Routine } from "../types"
import { t } from "../i18n"

type RoutinesPanelProps = {
  open: boolean
  routines: Routine[]
  busy: boolean
  onAdd: (input: { name: string; prompt: string; intervalMinutes: number }) => void
  onToggle: (id: string) => void
  onRemove: (id: string) => void
  onRun: (id: string) => void
  onClose: () => void
}

const lastRunLabel = (routine: Routine) => {
  if (!routine.lastRunAt) return t("Never")
  return new Date(routine.lastRunAt).toLocaleString()
}

export const RoutinesPanel: Component<RoutinesPanelProps> = (props) => {
  const [name, setName] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [interval, setInterval] = createSignal("60")

  const submit = () => {
    const routineName = name().trim()
    const text = prompt().trim()
    const minutes = Number(interval())
    if (!routineName || !text || !Number.isFinite(minutes) || minutes <= 0) return
    props.onAdd({ name: routineName, prompt: text, intervalMinutes: minutes })
    setName("")
    setPrompt("")
    setInterval("60")
  }

  return (
    <Show when={props.open}>
    <div class="fc-modal-backdrop" onClick={props.onClose}>
      <div class="fc-modal fc-modal-wide" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div class="fc-modal-header">
          <span>{t("Routines")}</span>
          <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
            ×
          </button>
        </div>

        <Show
          when={props.routines.length > 0}
          fallback={
            <div class="fc-empty-state">
              <span class="fc-empty-title">{t("No routines")}</span>
              <span class="fc-empty-hint">{t("Create one below")}</span>
            </div>
          }
        >
          <ul class="fc-routine-list">
            <For each={props.routines}>
              {(routine) => (
                <li class="fc-routine-row">
                  <div class="fc-routine-info">
                    <span class="fc-routine-name">{routine.name}</span>
                    <span class="fc-routine-meta">
                      {t("every {minutes} min · last: {last}", {
                        minutes: routine.intervalMinutes,
                        last: lastRunLabel(routine),
                      })}
                    </span>
                  </div>
                  <button
                    class="fc-chip fc-chip-button"
                    classList={{ "fc-chip-active": routine.enabled }}
                    type="button"
                    onClick={() => props.onToggle(routine.id)}
                  >
                    {routine.enabled ? t("Active") : t("Paused")}
                  </button>
                  <button class="fc-button" type="button" disabled={props.busy} onClick={() => props.onRun(routine.id)}>
                    {t("Run")}
                  </button>
                  <button class="fc-button fc-button-danger" type="button" onClick={() => props.onRemove(routine.id)}>
                    {t("Remove")}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <div class="fc-routine-form">
          <input
            class="fc-question-custom"
            placeholder={t("Name")}
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
          <input
            class="fc-question-custom fc-routine-prompt"
            placeholder={t("prompt to run")}
            value={prompt()}
            onInput={(event) => setPrompt(event.currentTarget.value)}
          />
          <input
            class="fc-question-custom fc-routine-interval"
            type="number"
            min="1"
            value={interval()}
            onInput={(event) => setInterval(event.currentTarget.value)}
          />
          <button class="fc-button fc-button-primary" type="button" onClick={submit}>
            {t("Add")}
          </button>
        </div>
      </div>
    </div>
    </Show>
  )
}
