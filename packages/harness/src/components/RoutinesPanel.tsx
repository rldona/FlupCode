import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, type Component, type JSX } from "solid-js"
import type { AgentInfo, ModelInfo } from "../engine-types"
import { t } from "../i18n"
import { formatDateTime } from "../dates"
import { money } from "../cost"
import { formatTokens } from "../metrics"
import type { Attention } from "../attention"
import { runState } from "../run-state"
import { AttentionMark } from "./AttentionMark"
import { StateBadge } from "./StateBadge"
import type {
  ActionProfileSummary,
  Artifact,
  BrowserAllowRule,
  Routine,
  RoutineInput,
  RoutineRun,
  RoutineSchedule,
  Workflow,
} from "../types"
import { Modal, ModalClose, modalOpen } from "./Modal"

type RoutinesPanelProps = {
  open: boolean
  routines: Routine[]
  /** What each routine needs from the reader (UX-02), by id, and what each of its runs does. */
  routineAttention: Record<string, Attention | undefined>
  runAttention: (run: RoutineRun) => Attention | undefined
  busy: boolean
  busyRoutineID?: string
  serverAvailable: boolean
  serverLoading: boolean
  /** Shown instead of "unavailable" when the harness refused a tab that can pair (HE-01). */
  pairing?: JSX.Element
  projects: Array<{ directory: string; name: string }>
  models: ModelInfo[]
  agents: AgentInfo[]
  /** The web actions the server knows (WA-7); empty when no browser runtime is available. */
  actions: ActionProfileSummary[]
  /** Kept artifacts, so an image input can be pointed at one (WA-7). */
  artifacts: Artifact[]
  /** The workflows a routine in this folder can run, with the inputs each declares (RP-07). */
  loadWorkflows: (directory?: string) => Promise<Workflow[]>
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
  const label = scheduleWords(schedule)
  // A wall-clock schedule is read in its zone, so the zone is part of what it says (RP-07).
  return schedule.timezone && schedule.type !== "manual" && schedule.type !== "hourly" && schedule.type !== "interval"
    ? `${label} (${schedule.timezone})`
    : label
}

const scheduleWords = (schedule: RoutineSchedule) => {
  if (schedule.type === "manual") return t("Manual")
  if (schedule.type === "cron") return t("Cron {expression}", { expression: schedule.expression })
  if (schedule.type === "hourly") return t("Every hour")
  if (schedule.type === "interval") return t("every {minutes} min", { minutes: schedule.intervalMinutes })
  if (schedule.type === "weekdays") return t("Weekdays at {time}", { time: schedule.time })
  if (schedule.type === "weekly") {
    const day = days.find(([value]) => value === schedule.day)?.[1] ?? ""
    return t("{day} at {time}", { day: t(day), time: schedule.time })
  }
  return t("Daily at {time}", { time: schedule.time })
}

/** When it runs next, as the server reckons it (RP-07), read in the routine's own zone. */
const nextRunLabel = (routine: Routine) => {
  const next = routine.nextRunAt
  if (!next) return t("Not scheduled")
  if (next <= Date.now()) return t("Due now")
  return t("Next {time}", { time: formatDateTime(next, routine.schedule.timezone) })
}

/** The newest run that ended, whose verdict the row shows (RP-06). */
const lastSettled = (routine: Routine) =>
  routine.runs.find((run) => run.status !== "running" && run.status !== "awaiting")

/** The zones the browser knows, for the time zone field. */
const ZONES = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []

/** A wall-clock schedule, the kind a time zone applies to. */
const wallClock = (type: RoutineSchedule["type"]) => ["daily", "weekdays", "weekly", "cron"].includes(type)

const runLabel = (run: RoutineRun) => {
  if (run.status === "running") return t("Running")
  if (run.status === "awaiting") return t("Needs approval")
  if (run.status === "stopped") return t("Stopped")
  if (run.status === "failed") return t("Failed")
  return t("Succeeded")
}

/**
 * The consent a selected action needs to run unattended (WA-7).
 *
 * The same resource the plugin's `ctx.ask` uses: the origin for a read, `origin:id` for an action
 * with effects. Derived here so the user never has to type a permission by hand.
 */
const requiredAllow = (profile: ActionProfileSummary): BrowserAllowRule[] => [
  {
    permission: profile.sensitive ? "browser_sensitive" : "browser",
    pattern: profile.sensitive ? `${profile.origin}:${profile.id}` : profile.origin,
    action: "allow",
  },
]

/** The artifacts an image input can point at. */
const imageArtifacts = (artifacts: Artifact[]) =>
  artifacts.filter((artifact) => artifact.mime.startsWith("image/") || artifact.kind === "screenshot")

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
  // The workflows of the folder the routine runs in, read while the form is open (RP-07). Keyed by a
  // string, so typing in another field does not read them again.
  const [workflows] = createResource(
    () => (editing() ? `folder:${form().projectDirectory ?? ""}` : undefined),
    (key) => props.loadWorkflows(key.slice("folder:".length) || undefined).catch(() => []),
  )
  const chosenWorkflow = createMemo(() => (workflows() ?? []).find((workflow) => workflow.name === form().workflow?.name))

  createEffect(() => {
    if (!props.open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || modalOpen()) return
      props.onClose()
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
      action: routine.action,
      allow: routine.allow,
      missed: routine.missed,
      retry: routine.retry,
    })
    setEditing(true)
  }

  const select = (routine: Routine) => {
    setSelectedID(routine.id)
    setEditing(false)
  }

  const updateForm = (patch: Partial<RoutineInput>) => setForm((current) => ({ ...current, ...patch }))

  // The budget of each run the routine starts (UL-08): a number typed as text, kept only when positive.
  const updateBudget = (patch: { cost?: string; tokens?: string; softPct?: string }) => {
    const budget = { ...form().policy?.budget }
    const positive = (value: string) => {
      const number = Number(value.replace(/[\s,_]/g, ""))
      return value.trim() && Number.isFinite(number) && number > 0 ? number : undefined
    }
    if (patch.cost !== undefined) budget.cost = positive(patch.cost)
    if (patch.tokens !== undefined) budget.tokens = positive(patch.tokens)
    if (patch.softPct !== undefined) budget.softPct = positive(patch.softPct)
    updateForm({ policy: { ...form().policy, budget } })
  }

  const updateSchedule = (type: RoutineSchedule["type"]) => {
    const current = form().schedule
    if (type === current.type) return
    // The zone outlives a change of kind; a new wall-clock schedule starts in the reader's own.
    const timezone = current.timezone ?? (wallClock(type) ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined)
    const zone = timezone && wallClock(type) ? { timezone } : {}
    if (type === "manual") updateForm({ schedule: { type: "manual" } })
    if (type === "hourly") updateForm({ schedule: { type: "hourly" } })
    if (type === "daily") updateForm({ schedule: { type: "daily", time: "09:00", ...zone } })
    if (type === "weekdays") updateForm({ schedule: { type: "weekdays", time: "09:00", ...zone } })
    if (type === "weekly") updateForm({ schedule: { type: "weekly", day: 1, time: "09:00", ...zone } })
    if (type === "interval") updateForm({ schedule: { type: "interval", intervalMinutes: 60 } })
    if (type === "cron") updateForm({ schedule: { type: "cron", expression: "0 9 * * 1-5", ...zone } })
  }

  const updateScheduleFields = (patch: { time?: string; day?: number; intervalMinutes?: number; expression?: string; timezone?: string }) => {
    const current = form().schedule
    if (patch.timezone !== undefined) {
      updateForm({ schedule: { ...current, timezone: patch.timezone.trim() || undefined } })
      return
    }
    if (current.type === "cron") {
      updateForm({ schedule: { ...current, expression: patch.expression ?? current.expression } })
      return
    }
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

  const formExpressionValue = () => {
    const schedule = form().schedule
    return schedule.type === "cron" ? schedule.expression : ""
  }

  const formIntervalValue = () => {
    const schedule = form().schedule
    return "intervalMinutes" in schedule ? schedule.intervalMinutes : 60
  }

  const isAction = () => form().action !== undefined
  const selectedProfile = createMemo(() => props.actions.find((action) => action.id === form().action?.id))

  // Switching to an action picks the first one there is, so the form is never in a mode with
  // nothing chosen; switching back clears the consent that only made sense with the action.
  const setMode = (mode: "prompt" | "action") => {
    if (mode === "prompt") {
      updateForm({ action: undefined, allow: undefined })
      return
    }
    const first = props.actions[0]
    if (!first) return
    // The action drives the run, so instructions left over from the prompt mode would only be
    // ignored; clearing them keeps the saved routine honest.
    updateForm({ action: { id: first.id }, allow: requiredAllow(first), prompt: "" })
  }

  const selectAction = (id: string) => {
    const profile = props.actions.find((action) => action.id === id)
    // A different recipe has different inputs, so the values of the old one are dropped rather
    // than left behind as undeclared keys the server would refuse.
    const same = form().action?.id === id
    updateForm({
      action: { id, ...(same && form().action?.inputs ? { inputs: form().action?.inputs } : {}) },
      allow: profile ? requiredAllow(profile) : undefined,
    })
  }

  const updateActionInput = (name: string, value: unknown) => {
    const action = form().action
    if (!action) return
    updateForm({ action: { ...action, inputs: { ...(action.inputs ?? {}), [name]: value } } })
  }

  const actionInputValue = (name: string) => {
    const value = form().action?.inputs?.[name]
    return typeof value === "string" ? value : ""
  }

  const actionImageValue = (name: string) => {
    const value = form().action?.inputs?.[name]
    if (value && typeof value === "object" && "artifactId" in value && typeof value.artifactId === "string")
      return value.artifactId
    return ""
  }

  // What the chosen workflow declares and somebody filled; an empty field takes the file's default.
  const workflowInputs = (value: RoutineInput) => {
    const declared = chosenWorkflow()?.inputs
    const entries = Object.entries(value.workflow?.inputs ?? {}).filter(
      ([name, entry]) => entry.trim() && (!declared || declared.includes(name)),
    )
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  }

  const updateWorkflowInput = (name: string, value: string) => {
    const workflow = form().workflow
    if (!workflow) return
    updateForm({ workflow: { ...workflow, inputs: { ...workflow.inputs, [name]: value } } })
  }

  const submit = () => {
    const value = form()
    if (!value.name.trim()) return
    if (!value.action && !value.prompt.trim()) return
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
    const inputs = workflowInputs(value)
    const input: RoutineInput = {
      ...value,
      name: value.name.trim(),
      prompt: value.prompt.trim(),
      // An action drives the run, so the workflow it might have named is not what runs (WA-7).
      action: value.action,
      allow: value.action ? value.allow : undefined,
      workflow:
        !value.action && workflowName
          ? { name: workflowName, ...(inputs ? { inputs } : {}) }
          : undefined,
      policy,
      missed: value.missed === "skip" ? "skip" : undefined,
      retry: value.retry && value.retry.count > 0 ? value.retry : undefined,
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
            <button class="fc-button fc-button-primary" type="button" disabled={!props.serverAvailable} onClick={openCreate}>＋ {t("New routine")}</button>
          </div>
        </div>

        <Show
          when={!props.serverAvailable && !props.serverLoading && props.pairing}
          fallback={
            <div class="fc-routines-notice">
              <span class="fc-routines-notice-icon">◷</span>
              <span>{props.serverLoading ? t("Connecting to the routines server…") : props.serverAvailable ? t("Routines are managed by the harness server and continue when this window is closed.") : t("The routines server is unavailable. Start FlupCode's harness server to manage routines.")}</span>
            </div>
          }
        >
          {props.pairing}
        </Show>

        <div class="fc-routines-toolbar">
          <input class="fc-question-custom fc-routines-search" value={search()} placeholder={t("Search routines")} aria-label={t("Search routines")} onInput={(event) => setSearch(event.currentTarget.value)} />
        </div>

        <Show when={visible().length > 0} fallback={(!props.pairing || props.serverAvailable) && <div class="fc-routines-empty"><div class="fc-routines-empty-icon">◷</div><h2>{search() ? t("No routines found") : t("No routines yet")}</h2><p>{search() ? t("Try a different search.") : t("Create a routine to automate a repeatable task.")}</p><button class="fc-button fc-button-primary" type="button" disabled={!props.serverAvailable} onClick={openCreate}>{t("Create your first routine")}</button></div>}>
            <div class="fc-routines-layout">
              <div class="fc-routine-cards"><For each={visible()}>{(routine) => <button class="fc-routine-card" classList={{ "fc-routine-card-selected": selectedID() === routine.id }} type="button" onClick={() => select(routine)}><span class="fc-routine-card-icon">◷</span><span class="fc-routine-card-content"><strong>{routine.name}</strong><span>{routine.description || routine.prompt}</span><small>{scheduleLabel(routine.schedule)} · {nextRunLabel(routine)}</small><Show when={lastSettled(routine)}>{(run) => <span class="fc-routine-card-last"><StateBadge state={runState(run())} reason={run().verdict?.reason ?? run().error} /><Show when={routine.failedInARow > 0}><small>{t("{count} failed in a row", { count: routine.failedInARow })}</small></Show></span>}</Show></span><Show when={props.routineAttention[routine.id]}>{(level) => <AttentionMark level={level()} />}</Show><span class="fc-routine-status" classList={{ "fc-routine-status-off": !routine.enabled }}>{routine.enabled ? t("Active") : t("Paused")}</span></button>}</For></div>
            </div>
            <Show when={selected()}>
              {(routine) => (
                <Modal
                  onClose={() => setSelectedID(undefined)}
                  class="fc-modal fc-detail-modal fc-routines-detail"
                  label={routine().name}
                >
                  <div class="fc-modal-header">
                    <span>{routine().name}</span>
                    <ModalClose />
                  </div>
                  <div class="fc-modal-body">
                    <div class="fc-routines-kicker">{t("Routine")}</div>
                    <p>{routine().description || t("No description")}</p>
                    <dl class="fc-routine-facts"><div><dt>{t("Schedule")}</dt><dd>{scheduleLabel(routine().schedule)}</dd></div><div><dt>{t("Project")}</dt><dd dir="auto">{routine().projectDirectory ?? t("No folder")}</dd></div><div><dt>{t("Agent")}</dt><dd>{routine().agent ?? t("Default")}</dd></div><div><dt>{t("Next run")}</dt><dd>{nextRunLabel(routine())}</dd></div><Show when={routine().workflow}><div><dt>{t("Workflow")}</dt><dd>{routine().workflow!.name}</dd></div></Show><Show when={routine().action}><div><dt>{t("Action")}</dt><dd>{routine().action!.id}</dd></div></Show><Show when={routine().allow && routine().allow!.length > 0}><div><dt>{t("Approval")}</dt><dd>{routine().allow!.map((rule) => rule.pattern).join(", ")}</dd></div></Show><Show when={routine().policy?.fallback}><div><dt>{t("Fallback")}</dt><dd>{routine().policy!.fallback}</dd></div></Show><Show when={budgetFact(routine().policy?.budget)}>{(fact) => <div><dt>{t("Budget")}</dt><dd>{fact()}</dd></div>}</Show><Show when={routine().retry}>{(retry) => <div><dt>{t("Retries")}</dt><dd>{t("{count} after {minutes} min", { count: retry().count, minutes: retry().backoffMinutes })}</dd></div>}</Show><Show when={routine().schedule.type !== "manual"}><div><dt>{t("Missed runs")}</dt><dd>{routine().missed === "skip" ? t("Skip them") : t("Run once when back")}</dd></div></Show></dl>
                    <section class="fc-routine-detail-section"><h3>{t("Instructions")}</h3><pre dir="auto">{routine().prompt}</pre></section>
                    <section class="fc-routine-detail-section"><h3>{t("Run history")}</h3><Show when={routine().runs.length > 0} fallback={<p class="fc-routine-muted">{t("No runs yet")}</p>}><ul class="fc-routine-runs"><For each={routine().runs}>{(run) => <li><Show when={props.runAttention(run)} fallback={<span class="fc-routine-run-dot" classList={{ "fc-routine-run-dot-failed": run.status === "failed", "fc-routine-run-dot-stopped": run.status === "stopped" }} />}>{(level) => <AttentionMark level={level()} />}</Show><span><strong>{runLabel(run)}</strong><small>{formatDateTime(run.startedAt)}</small></span><Show when={run.error}><small>{run.error}</small></Show><Show when={run.sessionID}><button class="fc-button" type="button" onClick={() => props.onOpenSession(run.sessionID!)}>{t("Open run")}</button></Show></li>}</For></ul></Show></section>
                  </div>
                  <div class="fc-dialog-actions">
                    <Show
                      when={deleteID() !== routine().id}
                      fallback={
                        <>
                          <span>{t("Delete this routine?")}</span>
                          <button class="fc-button" type="button" onClick={() => setDeleteID(undefined)}>{t("Cancel")}</button>
                          <button class="fc-button fc-button-danger" type="button" onClick={() => { const id = routine().id; props.onRemove(id); setDeleteID(undefined); if (selectedID() === id) setSelectedID(undefined) }}>{t("Delete")}</button>
                        </>
                      }
                    >
                      <Show when={props.busy && props.busyRoutineID === routine().id} fallback={<button class="fc-button fc-button-primary" type="button" disabled={props.busy || !props.serverAvailable} onClick={() => props.onRun(routine().id)}>▶ {t("Run now")}</button>}>
                        <button class="fc-button fc-button-danger" type="button" onClick={props.onStop}>{t("Stop run")}</button>
                      </Show>
                      <button class="fc-button" type="button" onClick={() => openEdit(routine())}>{t("Edit")}</button>
                      <button class="fc-button" type="button" onClick={() => props.onToggle(routine().id)}>{routine().enabled ? t("Pause") : t("Resume")}</button>
                      <button class="fc-button fc-button-danger" type="button" onClick={() => setDeleteID(routine().id)}>{t("Delete")}</button>
                    </Show>
                  </div>
                </Modal>
              )}
            </Show>
          </Show>
        <Modal
          open={editing()}
          onClose={() => setEditing(false)}
          class="fc-modal fc-form-modal"
          label={selectedID() ? t("Edit routine") : t("New routine")}
        >
          <div class="fc-modal-header">
            <span>{selectedID() ? t("Edit routine") : t("New routine")}</span>
            <ModalClose />
          </div>
          <div class="fc-modal-body">
          <p class="fc-modal-note">{t("Configure the instructions, project and schedule.")}</p>
          <div class="fc-routine-editor-grid">
          <label>{t("Name")}<input class="fc-question-custom" value={form().name} placeholder={t("Routine name")} onInput={(event) => updateForm({ name: event.currentTarget.value })} /></label>
          <label>{t("Description")}<input class="fc-question-custom" value={form().description} placeholder={t("What this routine does")} onInput={(event) => updateForm({ description: event.currentTarget.value })} /></label>
          <label>{t("Mode")}<select class="fc-question-custom" value={isAction() ? "action" : "prompt"} onChange={(event) => setMode(event.currentTarget.value === "action" ? "action" : "prompt")}><option value="prompt">{t("A prompt")}</option><option value="action" disabled={props.actions.length === 0}>{t("A web action")}</option></select></label>
          <Show when={!isAction()}><label class="fc-routine-editor-wide">{t("Instructions")}<textarea class="fc-question-custom fc-routine-instructions" value={form().prompt} placeholder={t("Tell the agent what to do…")} onInput={(event) => updateForm({ prompt: event.currentTarget.value })} /></label></Show>
          <Show when={isAction()}>
            <label class="fc-routine-editor-wide">{t("Action")}<select class="fc-question-custom" value={form().action?.id ?? ""} onChange={(event) => selectAction(event.currentTarget.value)}><For each={props.actions}>{(action) => <option value={action.id}>{action.id} — {action.description}</option>}</For></select></label>
            <Show when={selectedProfile()}>
              {(profile) => (
                <Show when={Object.keys(profile().inputs).length > 0} fallback={<p class="fc-modal-note">{t("This action needs no inputs.")}</p>}>
                  <For each={Object.entries(profile().inputs)}>{([name, kind]) => (
                    <Show when={kind === "image"} fallback={<label>{name}<input class="fc-question-custom" value={actionInputValue(name)} onInput={(event) => updateActionInput(name, event.currentTarget.value)} /></label>}>
                      <label class="fc-routine-editor-wide">{name} · {t("Artifact")}<select class="fc-question-custom" value={actionImageValue(name)} onChange={(event) => updateActionInput(name, event.currentTarget.value ? { artifactId: event.currentTarget.value } : undefined)}><option value="">{t("Choose an artifact")}</option><For each={imageArtifacts(props.artifacts)}>{(artifact) => <option value={artifact.id}>{artifact.title}</option>}</For></select></label>
                    </Show>
                  )}</For>
                </Show>
              )}
            </Show>
            <Show when={selectedProfile()}>{(profile) => <p class="fc-modal-note">{profile().sensitive ? t("This action has effects; the routine carries the strong approval.") : t("This action only reads; the routine carries the read approval.")}</p>}</Show>
          </Show>
          <label>{t("Workflow (optional)")}<select class="fc-question-custom" value={form().workflow?.name ?? ""} disabled={isAction()} onChange={(event) => updateForm({ workflow: event.currentTarget.value ? { name: event.currentTarget.value } : undefined })}><option value="">{t("No workflow")}</option><For each={workflows() ?? []}>{(workflow) => <option value={workflow.name}>{workflow.name}</option>}</For><Show when={form().workflow && !chosenWorkflow()}><option value={form().workflow!.name}>{form().workflow!.name}</option></Show></select></label>
          <Show when={!isAction() && chosenWorkflow()}>
            {(workflow) => (
              <For each={workflow().inputs}>{(name) => <label>{name}<input class="fc-question-custom" value={form().workflow?.inputs?.[name] ?? ""} placeholder={workflow().inputDefaults?.[name] ?? ""} title={workflow().inputHelp?.[name]} onInput={(event) => updateWorkflowInput(name, event.currentTarget.value)} /></label>}</For>
            )}
          </Show>
          <label>{t("Fallback model")}<input class="fc-question-custom" value={form().policy?.fallback ?? ""} placeholder="provider/model" onInput={(event) => updateForm({ policy: { ...form().policy, fallback: event.currentTarget.value } })} /></label>
          {/* Each run it starts stops at this budget, at the step that crosses it (UL-08). A web action has no model to spend. */}
          <Show when={!isAction()}>
            <label>{t("Budget (cost)")}<input class="fc-question-custom" inputMode="decimal" value={form().policy?.budget?.cost ?? ""} placeholder="USD" onInput={(event) => updateBudget({ cost: event.currentTarget.value })} /></label>
            <label>{t("Budget (tokens)")}<input class="fc-question-custom" inputMode="numeric" value={form().policy?.budget?.tokens ?? ""} onInput={(event) => updateBudget({ tokens: event.currentTarget.value })} /></label>
            <label>{t("Warn at (%)")}<input class="fc-question-custom" inputMode="numeric" value={form().policy?.budget?.softPct ?? ""} placeholder="80" title={t("Warn once when a run has spent this share of its budget")} onInput={(event) => updateBudget({ softPct: event.currentTarget.value })} /></label>
          </Show>
          <label>{t("Project")}<select class="fc-question-custom" value={form().projectDirectory ?? ""} onChange={(event) => updateForm({ projectDirectory: event.currentTarget.value || undefined })}><option value="">{t("No folder")}</option><For each={props.projects}>{(project) => <option value={project.directory}>{project.name}</option>}</For></select></label>
          <label>{t("Agent")}<select class="fc-question-custom" value={form().agent ?? ""} onChange={(event) => updateForm({ agent: event.currentTarget.value || undefined })}><option value="">{t("Default")}</option><For each={props.agents.filter((agent) => !agent.hidden && agent.mode !== "subagent")}>{(agent) => <option value={agent.id}>{agent.id}</option>}</For></select></label>
          <label>{t("Model")}<select class="fc-question-custom" value={formModelValue()} onChange={(event) => { const [providerID, ...id] = event.currentTarget.value.split("/"); updateForm({ model: providerID && id.length > 0 ? { providerID, id: id.join("/") } : undefined }) }}><option value="">{t("Default model")}</option><For each={modelGroups()}>{(group) => <optgroup label={group.providerID}><For each={group.items}>{(model) => <option value={`${group.providerID}/${model.id}`}>{model.name}</option>}</For></optgroup>}</For></select></label>
          <label>{t("Schedule")}<select class="fc-question-custom" value={form().schedule.type} onChange={(event) => updateSchedule(event.currentTarget.value as RoutineSchedule["type"])}><option value="manual">{t("Manual")}</option><option value="hourly">{t("Every hour")}</option><option value="daily">{t("Daily")}</option><option value="weekdays">{t("Weekdays")}</option><option value="weekly">{t("Weekly")}</option><option value="interval">{t("Interval")}</option><option value="cron">{t("Cron expression")}</option></select></label>
          <Show when={["daily", "weekdays", "weekly"].includes(form().schedule.type)}><label>{t("Time")}<input class="fc-question-custom" type="time" value={formTimeValue()} onInput={(event) => updateScheduleFields({ time: event.currentTarget.value })} /></label></Show>
          <Show when={form().schedule.type === "weekly"}><label>{t("Day")}<select class="fc-question-custom" value={formDayValue()} onChange={(event) => updateScheduleFields({ day: Number(event.currentTarget.value) })}><For each={days}>{(day) => <option value={day[0]}>{t(day[1])}</option>}</For></select></label></Show>
          <Show when={form().schedule.type === "interval"}><label>{t("Minutes")}<input class="fc-question-custom" type="number" min="1" value={formIntervalValue()} onInput={(event) => updateScheduleFields({ intervalMinutes: Number(event.currentTarget.value) })} /></label></Show>
          <Show when={form().schedule.type === "cron"}><label>{t("Cron expression")}<input class="fc-question-custom" value={formExpressionValue()} placeholder="15 8 * * 1-5" spellcheck={false} onInput={(event) => updateScheduleFields({ expression: event.currentTarget.value })} /></label></Show>
          <Show when={wallClock(form().schedule.type)}><label>{t("Time zone")}<input class="fc-question-custom" list="fc-routine-zones" value={form().schedule.timezone ?? ""} placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone} spellcheck={false} onChange={(event) => updateScheduleFields({ timezone: event.currentTarget.value })} /><datalist id="fc-routine-zones"><For each={ZONES}>{(zone) => <option value={zone} />}</For></datalist></label></Show>
          <Show when={form().schedule.type !== "manual"}>
            <label>{t("Missed runs")}<select class="fc-question-custom" value={form().missed ?? "catch-up"} onChange={(event) => updateForm({ missed: event.currentTarget.value === "skip" ? "skip" : undefined })}><option value="catch-up">{t("Run once when back")}</option><option value="skip">{t("Skip them")}</option></select></label>
            <label>{t("Retries")}<input class="fc-question-custom" type="number" min="0" max="5" value={form().retry?.count ?? 0} onInput={(event) => updateForm({ retry: { count: Math.max(0, Math.min(5, Math.round(Number(event.currentTarget.value) || 0))), backoffMinutes: form().retry?.backoffMinutes ?? 5 } })} /></label>
            <Show when={(form().retry?.count ?? 0) > 0}><label>{t("Minutes before the first retry")}<input class="fc-question-custom" type="number" min="0" value={form().retry?.backoffMinutes ?? 5} onInput={(event) => updateForm({ retry: { count: form().retry?.count ?? 1, backoffMinutes: Math.max(0, Math.round(Number(event.currentTarget.value) || 0)) } })} /></label></Show>
          </Show>
          </div>
          </div>
          <div class="fc-dialog-actions">
            <button class="fc-button" type="button" onClick={() => setEditing(false)}>{t("Cancel")}</button>
            <button class="fc-button fc-button-primary" type="button" disabled={!props.serverAvailable || !form().name.trim() || (!form().prompt.trim() && !form().action)} onClick={submit}>{t("Save")}</button>
          </div>
        </Modal>
      </section>
    </Show>
  )
}

/** A routine's budget for each run, in one line: `$0.50 · 10K tokens · warns at 80%`. */
function budgetFact(budget: { cost?: number; tokens?: number; softPct?: number } | undefined) {
  if (!budget || (!budget.cost && !budget.tokens)) return undefined
  return [
    budget.cost ? money(budget.cost) : undefined,
    budget.tokens ? t("{n} tokens", { n: formatTokens(budget.tokens) }) : undefined,
    budget.softPct ? t("warns at {pct}%", { pct: budget.softPct }) : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
}
