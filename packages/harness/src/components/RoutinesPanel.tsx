import { For, Show, createSignal, type Component } from "solid-js"
import type { Routine } from "../types"

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
  if (!routine.lastRunAt) return "nunca"
  return new Date(routine.lastRunAt).toLocaleString()
}

export const RoutinesPanel: Component<RoutinesPanelProps> = (props) => {
  const [name, setName] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [interval, setInterval] = createSignal("60")

  if (!props.open) return null

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
    <div class="oh-modal-backdrop" onClick={props.onClose}>
      <div class="oh-modal oh-modal-wide" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div class="oh-modal-header">
          <span>Rutinas</span>
          <button class="oh-icon-button" type="button" aria-label="Cerrar" onClick={props.onClose}>
            ×
          </button>
        </div>

        <Show
          when={props.routines.length > 0}
          fallback={
            <div class="oh-empty-state">
              <span class="oh-empty-title">Sin rutinas</span>
              <span class="oh-empty-hint">Crea una tarea programada abajo</span>
            </div>
          }
        >
          <ul class="oh-routine-list">
            <For each={props.routines}>
              {(routine) => (
                <li class="oh-routine-row">
                  <div class="oh-routine-info">
                    <span class="oh-routine-name">{routine.name}</span>
                    <span class="oh-routine-meta">
                      cada {routine.intervalMinutes} min · última: {lastRunLabel(routine)}
                    </span>
                  </div>
                  <button
                    class="oh-chip oh-chip-button"
                    classList={{ "oh-chip-active": routine.enabled }}
                    type="button"
                    onClick={() => props.onToggle(routine.id)}
                  >
                    {routine.enabled ? "Activa" : "Pausada"}
                  </button>
                  <button class="oh-button" type="button" disabled={props.busy} onClick={() => props.onRun(routine.id)}>
                    Ejecutar
                  </button>
                  <button
                    class="oh-button oh-button-danger"
                    type="button"
                    onClick={() => props.onRemove(routine.id)}
                  >
                    Quitar
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <div class="oh-routine-form">
          <input
            class="oh-question-custom"
            placeholder="Nombre"
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
          <input
            class="oh-question-custom oh-routine-prompt"
            placeholder="Prompt a ejecutar"
            value={prompt()}
            onInput={(event) => setPrompt(event.currentTarget.value)}
          />
          <input
            class="oh-question-custom oh-routine-interval"
            type="number"
            min="1"
            value={interval()}
            onInput={(event) => setInterval(event.currentTarget.value)}
          />
          <button class="oh-button oh-button-primary" type="button" onClick={submit}>
            Añadir
          </button>
        </div>
      </div>
    </div>
  )
}
