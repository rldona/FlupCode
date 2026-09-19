import { For, Show, createEffect, createSignal, on, type Component } from "solid-js"
import { t } from "../i18n"
import type { ContextPack, RunPolicy, Workflow } from "../types"

export type WorkflowLaunch = {
  inputs: Record<string, string>
  packs: string[]
  worktrees: boolean
  policy?: RunPolicy
  /** Stop at this task, inclusive (HF-1). Absent means the whole workflow. */
  until?: string
}

type WorkflowLaunchDialogProps = {
  open: boolean
  workflow?: Workflow
  /** What can be given to every task of the run (H-31). */
  packs: ContextPack[]
  /** Whatever was typed after the workflow's name, for its first input. */
  initialArgs?: string
  onLaunch: (launch: WorkflowLaunch) => void
  onClose: () => void
}

const policyFrom = (fallback: string, tokens: string, cost: string): RunPolicy | undefined => {
  const budget: { tokens?: number; cost?: number } = {}
  const parsedTokens = Number(tokens.replace(/[\s,_]/g, ""))
  if (tokens.trim() && Number.isFinite(parsedTokens) && parsedTokens > 0) budget.tokens = Math.floor(parsedTokens)
  const parsedCost = Number(cost.replace(/[\s,_]/g, ""))
  if (cost.trim() && Number.isFinite(parsedCost) && parsedCost > 0) budget.cost = parsedCost
  const policy: RunPolicy = {
    ...(fallback.trim() ? { fallback: fallback.trim() } : {}),
    ...(Object.keys(budget).length > 0 ? { budget } : {}),
  }
  return Object.keys(policy).length > 0 ? policy : undefined
}

/**
 * How a workflow is launched (H-28), with everything a run can be given.
 *
 * H-31, H-29 and H-30 put packs, worktrees and a policy on a run, and each said the same thing: the
 * API takes it, and a selector in the UI asks for this dialog. It also fixes what the composer could
 * not do — a workflow with more than one input had nowhere to put the rest, so it refused to start.
 */
export const WorkflowLaunchDialog: Component<WorkflowLaunchDialogProps> = (props) => {
  const [inputs, setInputs] = createSignal<Record<string, string>>({})
  const [packs, setPacks] = createSignal<string[]>([])
  const [worktrees, setWorktrees] = createSignal(false)
  const [until, setUntil] = createSignal("")
  const [fallback, setFallback] = createSignal("")
  const [budgetTokens, setBudgetTokens] = createSignal("")
  const [budgetCost, setBudgetCost] = createSignal("")

  createEffect(
    on(
      () => [props.open, props.workflow, props.initialArgs] as const,
      ([open, workflow, args]) => {
        if (!open || !workflow) return
        const [first] = workflow.inputs
        // Only the first input can come from the composer's one line; the rest start empty on purpose,
        // because a launch with a half-filled workflow is the bug this dialog fixes.
        setInputs(Object.fromEntries(workflow.inputs.map((name) => [name, name === first ? (args ?? "") : ""])))
        setPacks([])
        setWorktrees(false)
        setUntil("")
        setFallback("")
        setBudgetTokens("")
        setBudgetCost("")
      },
    ),
  )

  const complete = () => (props.workflow?.inputs ?? []).every((name) => inputs()[name]?.trim())

  const launch = () => {
    if (!props.workflow || !complete()) return
    props.onLaunch({
      inputs: Object.fromEntries(Object.entries(inputs()).map(([name, value]) => [name, value.trim()])),
      packs: packs(),
      worktrees: worktrees(),
      policy: policyFrom(fallback(), budgetTokens(), budgetCost()),
      ...(until().trim() ? { until: until().trim() } : {}),
    })
  }

  const togglePack = (name: string, on: boolean) =>
    setPacks((current) => (on ? [...current, name] : current.filter((entry) => entry !== name)))

  return (
    <Show when={props.open && props.workflow}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div
          class="fc-modal fc-launch-modal"
          role="dialog"
          aria-modal="true"
          aria-label={t("Run {name}", { name: props.workflow?.name ?? "" })}
          onClick={(event) => event.stopPropagation()}
        >
          <div class="fc-modal-header">
            <span>{t("Run {name}", { name: props.workflow?.name ?? "" })}</span>
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
              ×
            </button>
          </div>

          <p class="fc-usage-note">{props.workflow?.description}</p>

          <For each={props.workflow?.inputs ?? []}>
            {(name) => (
              <label class="fc-field">
                <span>{name}</span>
                <input
                  class="fc-question-custom"
                  value={inputs()[name] ?? ""}
                  placeholder={name}
                  onInput={(event) => setInputs((current) => ({ ...current, [name]: event.currentTarget.value }))}
                />
              </label>
            )}
          </For>

          <Show when={props.packs.length > 0}>
            <div class="fc-field">
              <span>{t("Context packs")}</span>
              <div class="fc-launch-packs">
                <For each={props.packs}>
                  {(pack) => (
                    <label class="fc-field-row">
                      <input
                        type="checkbox"
                        checked={packs().includes(pack.name)}
                        onChange={(event) => togglePack(pack.name, event.currentTarget.checked)}
                      />
                      <span>{pack.name}</span>
                    </label>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <label class="fc-field-row">
            <input type="checkbox" checked={worktrees()} onChange={(event) => setWorktrees(event.currentTarget.checked)} />
            <span>{t("A worktree per writing task")}</span>
          </label>

          <Show when={(props.workflow?.tasks ?? []).length > 1}>
            <label class="fc-field">
              <span>{t("Run until task")}</span>
              <select
                class="fc-question-custom"
                value={until()}
                onChange={(event) => setUntil(event.currentTarget.value)}
              >
                <option value="">{t("Whole workflow")}</option>
                <For each={props.workflow?.tasks ?? []}>{(task) => <option value={task.id}>{task.id}</option>}</For>
              </select>
            </label>
          </Show>

          <label class="fc-field">
            <span>{t("Fallback model")}</span>
            <input
              class="fc-question-custom"
              placeholder="provider/model"
              value={fallback()}
              onInput={(event) => setFallback(event.currentTarget.value)}
            />
          </label>
          <div class="fc-field-row">
            <label class="fc-field">
              <span>{t("Budget (tokens)")}</span>
              <input
                class="fc-question-custom"
                inputMode="numeric"
                value={budgetTokens()}
                onInput={(event) => setBudgetTokens(event.currentTarget.value)}
              />
            </label>
            <label class="fc-field">
              <span>{t("Budget (cost)")}</span>
              <input
                class="fc-question-custom"
                inputMode="decimal"
                value={budgetCost()}
                onInput={(event) => setBudgetCost(event.currentTarget.value)}
              />
            </label>
          </div>

          <div class="fc-dialog-actions">
            <button class="fc-button" type="button" onClick={props.onClose}>
              {t("Cancel")}
            </button>
            <button class="fc-button fc-button-primary" type="button" disabled={!complete()} onClick={launch}>
              {t("Run")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
