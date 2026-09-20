import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import type { AgentInfo, ModelInfo } from "../engine-types"
import { t } from "../i18n"
import { routineNextRunAt } from "../routine-schedule"
import type { Routine, RoutineInput, RoutineRun, RoutineSchedule } from "../types"

type RoutinesPanelProps = {
  open: boolean
  routines: Routine[]
  busy: boolean
  busyRoutineID?: string
  serverAvailable: boolean
  serverLoading: boolean
  projects: Array<{ directory: string; name: string }>
  models: ModelInfo[]
  agents: AgentInfo[]
  onAdd: (input: RoutineInput) => void
  onUpdate: (id: string, input: RoutineInput) => void
  onToggle: (id: string) => void
  onRemove: (id: string) => void
  onRun: (id: string) => void
  onStop: () => void
  onOpenSession: (id: string) => void
  /** A routine to open on, asked for from outside — the sidebar's list. */
  focus?: string
  onFocused?: () => void
  onClose: () => void
}

const days = [
  [1, "Monday"],
  [2, "Tuesday"],
  [3, "Wednesday"],
  [4, "Thursday"],
  [5, "Friday"],
  [6, "Saturday"],
  [0, "Sunday"],
] as const

const scheduleLabel = (schedule: RoutineSchedule) => {
  if (schedule.type === "manual") return t("Manual")
  if (schedule.type === "hourly") return t("Every hour")
  if (schedule.type === "interval") return t("every {minutes} min", { minutes: schedule.intervalMinutes })
  if (schedule.type === "weekdays") return t("Weekdays at {time}", { time: schedule.time })
  if (schedule.type === "weekly") {
    const day = days.find(([value]) => value === schedule.day)?.[1] ?? ""
    return t("{day} at {time}", { day: t(day), time: schedule.time })
  }
  return t("Daily at {time}", { time: schedule.time })
}

const nextRunLabel = (routine: Routine) => {
  const next = routineNextRunAt(routine)
  if (!next) return t("Not scheduled")
  if (next <= Date.now()) return t("Due now")
  return t("Next {time}", { time: new Date(next).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) })
}

const runLabel = (run: RoutineRun) => {
  if (run.status === "running") return t("Running")
  if (run.status === "stopped") return t("Stopped")
  if (run.status === "failed") return t("Failed")
  return t("Succeeded")
}

const emptyInput = (): RoutineInput => ({
  name: "",
  description: "",
  prompt: "",
  schedule: { type: "manual" },
})

export const RoutinesPanel: Component<RoutinesPanelProps> = (props) => {
  const [selectedID, setSelectedID] = createSignal<string>()
  const [editing, setEditing] = createSignal(false)
  const [search, setSearch] = createSignal("")
  const [form, setForm] = createSignal<RoutineInput>(emptyInput())
  const [deleteID, setDeleteID] = createSignal<string>()

  createEffect(() => {
    if (!props.open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose()
    }
    document.addEventListener("keydown", closeOnEscape)
    onCleanup(() => document.removeEventListener("keydown", closeOnEscape))
  })

  const selected = createMemo(() => props.routines.find((routine) => routine.id === selectedID()))
  // Opened from the sidebar on a particular routine. Cleared straight away, so that closing the
  // detail does not have the screen reopen it on the next render.
  createEffect(() => {
    const focus = props.focus
    if (!props.open || !focus) return
    setSelectedID(focus)
    props.onFocused?.()
  })
  const visible = createMemo(() => {
    const query = search().trim().toLowerCase()
    if (!query) return props.routines
    return props.routines.filter((routine) => `${routine.name} ${routine.description}`.toLowerCase().includes(query))
  })

  const openCreate = () => {
    setSelectedID(undefined)
    setForm(emptyInput())
    setEditing(true)
  }

  const openEdit = (routine: Routine) => {
    setSelectedID(routine.id)
    setForm({
      name: routine.name,
      description: routine.description,
      prompt: routine.prompt,
      schedule: routine.schedule,
      projectDirectory: routine.projectDirectory,
      agent: routine.agent,
      model: routine.model,
      workflow: routine.workflow,
      policy: routine.policy,
    })
    setEditing(true)
  }

  const select = (routine: Routine) => {
    setSelectedID(routine.id)
    setEditing(false)
  }

  const updateForm = (patch: Partial<RoutineInput>) => setForm((current) => ({ ...current, ...patch }))

  const updateSchedule = (patch: Partial<RoutineSchedule> & { type?: RoutineSchedule["type"] }) => {
    const current = form().schedule
    const type = patch.type ?? current.type
    if (type === "manual") updateForm({ schedule: { type: "manual" } })
    if (type === "hourly") updateForm({ schedule: { type: "hourly" } })
    if (type === "daily") updateForm({ schedule: { type: "daily", time: "09:00" } })
    if (type === "weekdays") updateForm({ schedule: { type: "weekdays", time: "09:00" } })
    if (type === "weekly") updateForm({ schedule: { type: "weekly", day: 1, time: "09:00" } })
    if (type === "interval") updateForm({ schedule: { type: "interval", intervalMinutes: 60 } })
    if (type === current.type) updateForm({ schedule: { ...current, ...patch } as RoutineSchedule })
  }

  const updateScheduleFields = (patch: { time?: string; day?: number; intervalMinutes?: number }) => {
    const current = form().schedule
    if (current.type === "daily" || current.type === "weekdays") {
      updateForm({ schedule: { ...current, time: patch.time ?? current.time } })
      return
    }
    if (current.type === "weekly") {
      updateForm({ schedule: { ...current, time: patch.time ?? current.time, day: patch.day ?? current.day } })
      return
    }
    if (current.type === "interval") {
      const value = patch.intervalMinutes
      updateForm({
        schedule: {
          ...current,
          intervalMinutes: typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1,
        },
      })
    }
  }

  const formModelValue = () => {
    const model = form().model
    return model ? `${model.providerID}/${model.id}` : ""
  }

  // Model names repeat across providers and say nothing about where they come from, so the list is
  // cut by provider the way the model picker does it: the provider is on screen next to the name.
  const modelGroups = createMemo(() => {
    const groups = new Map<string, ModelInfo[]>()
    for (const model of props.models) groups.set(model.providerID, [...(groups.get(model.providerID) ?? []), model])
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([providerID, items]) => ({ providerID, items: [...items].sort((a, b) => a.name.localeCompare(b.name)) }))
  })

  const formTimeValue = () => {
    const schedule = form().schedule
    return "time" in schedule ? schedule.time : "09:00"
  }

  const formDayValue = () => {
    const schedule = form().schedule
    return "day" in schedule ? schedule.day : 1
  }

  const formIntervalValue = () => {
    const schedule = form().schedule
    return "intervalMinutes" in schedule ? schedule.intervalMinutes : 60
  }

  const submit = () => {
    const value = form()
    if (!value.name.trim() || !value.prompt.trim()) return
    const workflowName = value.workflow?.name.trim()
    const fallback = value.policy?.fallback?.trim()
    const budget = value.policy?.budget
    const policy =
      fallback || budget?.tokens || budget?.cost
        ? {
            ...(fallback ? { fallback } : {}),
            ...(budget && (budget.tokens || budget.cost) ? { budget } : {}),
          }
        : undefined
    const input: RoutineInput = {
      ...value,
      name: value.name.trim(),
      prompt: value.prompt.trim(),
      workflow: workflowName ? { name: workflowName, ...(value.workflow?.inputs ? { inputs: value.workflow.inputs } : {}) } : undefined,
      policy,
    }
    const id = selectedID()
    if (id) props.onUpdate(id, input)
    else props.onAdd(input)
    setEditing(false)
  }

  return (
    <Show when={props.open}>
      <section class="fc-routines-screen" aria-label={t("Routines")}>
        <div class="fc-routines-header">
          <div>
            <div class="fc-routines-kicker">{t("Automation")}</div>
            <h1>{t("Routines")}</h1>
            <p>{t("Run repeatable tasks in your OpenCode projects.")}</p>
          </div>
          <div class="fc-routines-header-actions">
            <button class="fc-button" type="button" onClick={props.onClose}>{t("Back to sessions")}</button>
            <button class="fc-button fc-button-primary" type="button" disabled={!props.serverAvailable} onClick={openCreate}>＋ {t("New routine")}</button>
          </div>
        </div>

        <div class="fc-routines-notice">
          <span class="fc-routines-notice-icon">◷</span>
          <span>{props.serverLoading ? t("Connecting to the routines server…") : props.serverAvailable ? t("Routines are managed by the harness server and continue when this window is closed.") : t("The routines server is unavailable. Start FlupCode's harness server to manage routines.")}</span>
        </div>

        <div class="fc-routines-toolbar">
          <div class="fc-routines-tabs"><button class="fc-routines-tab fc-routines-tab-active" type="button">{t("Yours")}</button><button class="fc-routines-tab" type="button" disabled title={t("Coming soon")}>{t("Templates")}<span class="fc-nav-soon">{t("Soon")}</span></button></div>
          <input class="fc-question-custom fc-routines-search" value={search()} placeholder={t("Search routines")} aria-label={t("Search routines")} onInput={(event) => setSearch(event.currentTarget.value)} />
        </div>

        <Show when={!editing()} fallback={
          <div class="fc-routine-editor">
            <div class="fc-routine-editor-heading"><button class="fc-button" type="button" onClick={() => setEditing(false)}>← {t("Back")}</button><div><h2>{selectedID() ? t("Edit routine") : t("New routine")}</h2><p>{t("Configure the instructions, project and schedule.")}</p></div></div>
            <div class="fc-routine-editor-grid">
              <label>{t("Name")}<input class="fc-question-custom" value={form().name} placeholder={t("Routine name")} onInput={(event) => updateForm({ name: event.currentTarget.value })} /></label>
              <label>{t("Description")}<input class="fc-question-custom" value={form().description} placeholder={t("What this routine does")} onInput={(event) => updateForm({ description: event.currentTarget.value })} /></label>
              <label class="fc-routine-editor-wide">{t("Instructions")}<textarea class="fc-question-custom fc-routine-instructions" value={form().prompt} placeholder={t("Tell the agent what to do…")} onInput={(event) => updateForm({ prompt: event.currentTarget.value })} /></label>
              <label>{t("Workflow (optional)")}<input class="fc-question-custom" value={form().workflow?.name ?? ""} placeholder={t("feature")} onInput={(event) => updateForm({ workflow: event.currentTarget.value.trim() ? { name: event.currentTarget.value } : undefined })} /></label>
              <label>{t("Fallback model")}<input class="fc-question-custom" value={form().policy?.fallback ?? ""} placeholder="provider/model" onInput={(event) => updateForm({ policy: { ...form().policy, fallback: event.currentTarget.value } })} /></label>
              <label>{t("Project")}<select class="fc-question-custom" value={form().projectDirectory ?? ""} onChange={(event) => updateForm({ projectDirectory: event.currentTarget.value || undefined })}><option value="">{t("No folder")}</option><For each={props.projects}>{(project) => <option value={project.directory}>{project.name}</option>}</For></select></label>
              <label>{t("Agent")}<select class="fc-question-custom" value={form().agent ?? ""} onChange={(event) => updateForm({ agent: event.currentTarget.value || undefined })}><option value="">{t("Default")}</option><For each={props.agents.filter((agent) => !agent.hidden && agent.mode !== "subagent")}>{(agent) => <option value={agent.id}>{agent.id}</option>}</For></select></label>
              <label>{t("Model")}<select class="fc-question-custom" value={formModelValue()} onChange={(event) => { const [providerID, ...id] = event.currentTarget.value.split("/"); updateForm({ model: providerID && id.length > 0 ? { providerID, id: id.join("/") } : undefined }) }}><option value="">{t("Default model")}</option><For each={modelGroups()}>{(group) => <optgroup label={group.providerID}><For each={group.items}>{(model) => <option value={`${group.providerID}/${model.id}`}>{model.name}</option>}</For></optgroup>}</For></select></label>
              <label>{t("Schedule")}<select class="fc-question-custom" value={form().schedule.type} onChange={(event) => updateSchedule({ type: event.currentTarget.value as RoutineSchedule["type"] })}><option value="manual">{t("Manual")}</option><option value="hourly">{t("Every hour")}</option><option value="daily">{t("Daily")}</option><option value="weekdays">{t("Weekdays")}</option><option value="weekly">{t("Weekly")}</option><option value="interval">{t("Interval")}</option></select></label>
              <Show when={["daily", "weekdays", "weekly"].includes(form().schedule.type)}><label>{t("Time")}<input class="fc-question-custom" type="time" value={formTimeValue()} onInput={(event) => updateScheduleFields({ time: event.currentTarget.value })} /></label></Show>
              <Show when={form().schedule.type === "weekly"}><label>{t("Day")}<select class="fc-question-custom" value={formDayValue()} onChange={(event) => updateScheduleFields({ day: Number(event.currentTarget.value) })}><For each={days}>{(day) => <option value={day[0]}>{t(day[1])}</option>}</For></select></label></Show>
              <Show when={form().schedule.type === "interval"}><label>{t("Minutes")}<input class="fc-question-custom" type="number" min="1" value={formIntervalValue()} onInput={(event) => updateScheduleFields({ intervalMinutes: Number(event.currentTarget.value) })} /></label></Show>
            </div>
            <div class="fc-dialog-actions"><button class="fc-button" type="button" onClick={() => setEditing(false)}>{t("Cancel")}</button><button class="fc-button fc-button-primary" type="button" disabled={!props.serverAvailable || !form().name.trim() || !form().prompt.trim()} onClick={submit}>{t("Save")}</button></div>
          </div>
        }>
          <Show when={visible().length > 0} fallback={<div class="fc-routines-empty"><div class="fc-routines-empty-icon">◷</div><h2>{search() ? t("No routines found") : t("No routines yet")}</h2><p>{search() ? t("Try a different search.") : t("Create a routine to automate a repeatable task.")}</p><button class="fc-button fc-button-primary" type="button" disabled={!props.serverAvailable} onClick={openCreate}>{t("Create your first routine")}</button></div>}>
            <div class="fc-routines-layout">
              <div class="fc-routine-cards"><For each={visible()}>{(routine) => <button class="fc-routine-card" classList={{ "fc-routine-card-selected": selectedID() === routine.id }} type="button" onClick={() => select(routine)}><span class="fc-routine-card-icon">◷</span><span class="fc-routine-card-content"><strong>{routine.name}</strong><span>{routine.description || routine.prompt}</span><small>{scheduleLabel(routine.schedule)} · {nextRunLabel(routine)}</small></span><span class="fc-routine-status" classList={{ "fc-routine-status-off": !routine.enabled }}>{routine.enabled ? t("Active") : t("Paused")}</span></button>}</For></div>
              <Show when={selected()} fallback={<div class="fc-routines-detail fc-routines-detail-empty"><span>{t("Select a routine to see its details.")}</span></div>}>{(routine) => <article class="fc-routines-detail"><div class="fc-routines-detail-top"><div><div class="fc-routines-kicker">{t("Routine")}</div><h2>{routine().name}</h2><p>{routine().description || t("No description")}</p></div><button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={() => setSelectedID(undefined)}>×</button></div><div class="fc-routine-detail-actions"><Show when={props.busy && props.busyRoutineID === routine().id} fallback={<button class="fc-button fc-button-primary" type="button" disabled={props.busy || !props.serverAvailable} onClick={() => props.onRun(routine().id)}>▶ {t("Run now")}</button>}><button class="fc-button fc-button-danger" type="button" onClick={props.onStop}>{t("Stop run")}</button></Show><button class="fc-button" type="button" onClick={() => openEdit(routine())}>{t("Edit")}</button><button class="fc-button" type="button" onClick={() => props.onToggle(routine().id)}>{routine().enabled ? t("Pause") : t("Resume")}</button><button class="fc-button fc-button-danger" type="button" onClick={() => setDeleteID(routine().id)}>{t("Delete")}</button></div><Show when={deleteID() === routine().id}><div class="fc-confirm-inline"><span>{t("Delete this routine?")}</span><button class="fc-button" type="button" onClick={() => setDeleteID(undefined)}>{t("Cancel")}</button><button class="fc-button fc-button-danger" type="button" onClick={() => { const id = routine().id; props.onRemove(id); setDeleteID(undefined); if (selectedID() === id) setSelectedID(undefined) }}>{t("Delete")}</button></div></Show><dl class="fc-routine-facts"><div><dt>{t("Schedule")}</dt><dd>{scheduleLabel(routine().schedule)}</dd></div><div><dt>{t("Project")}</dt><dd dir="auto">{routine().projectDirectory ?? t("No folder")}</dd></div><div><dt>{t("Agent")}</dt><dd>{routine().agent ?? t("Default")}</dd></div><div><dt>{t("Next run")}</dt><dd>{nextRunLabel(routine())}</dd></div><Show when={routine().workflow}><div><dt>{t("Workflow")}</dt><dd>{routine().workflow!.name}</dd></div></Show><Show when={routine().policy?.fallback}><div><dt>{t("Fallback")}</dt><dd>{routine().policy!.fallback}</dd></div></Show></dl><section class="fc-routine-detail-section"><h3>{t("Instructions")}</h3><pre dir="auto">{routine().prompt}</pre></section><section class="fc-routine-detail-section"><h3>{t("Run history")}</h3><Show when={routine().runs.length > 0} fallback={<p class="fc-routine-muted">{t("No runs yet")}</p>}><ul class="fc-routine-runs"><For each={routine().runs}>{(run) => <li><span class="fc-routine-run-dot" classList={{ "fc-routine-run-dot-failed": run.status === "failed", "fc-routine-run-dot-running": run.status === "running", "fc-routine-run-dot-stopped": run.status === "stopped" }} /><span><strong>{runLabel(run)}</strong><small>{new Date(run.startedAt).toLocaleString()}</small></span><Show when={run.error}><small>{run.error}</small></Show><Show when={run.sessionID}><button class="fc-button" type="button" onClick={() => props.onOpenSession(run.sessionID!)}>{t("Open run")}</button></Show></li>}</For></ul></Show></section></article>}</Show>
            </div>
          </Show>
        </Show>
      </section>
    </Show>
  )
}
