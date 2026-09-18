import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import type { ModelInfo } from "../engine-types"
import type { Artifact, Run, Task, TaskActivity, TaskTools, TouchedFiles } from "../types"
import { duration, money } from "./UsagePanel"

type RunTaskDetailProps = {
  run: Run
  task: Task
  /** What the task is doing right now, when it is running (H-12). */
  activity?: TaskActivity
  /** What it changed on disk, worked out from the checkpoints around it (H-12, H-15). */
  touched?: TouchedFiles
  /** The calls it made, timed by FlupCode's engine plugin (H-16). */
  tools?: TaskTools
  /** What the run left behind, for the task that produced it (H-14). */
  artifacts: Artifact[]
  models: ModelInfo[]
  serverAvailable: boolean
  onOpenSession: (id: string) => void
  onRetry: (taskID: string, model?: { providerID: string; id: string; variant?: string }) => void
  onSteer: (taskID: string, text: string) => void
  onOpenChanges: (directory?: string) => void
  onClose: () => void
}

const marks: Record<Task["status"], string> = {
  queued: "○",
  running: "◐",
  success: "●",
  failed: "✕",
  stopped: "■",
}

const elapsed = (from: number, to: number | undefined) => {
  const seconds = Math.max(0, Math.round(((to ?? Date.now()) - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
}

const thousands = (value: number | undefined) =>
  value === undefined ? undefined : value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(value)

const modelKey = (model: Task["model"]) => (model ? `${model.providerID}/${model.id}` : "")

/**
 * One task of a run, in full (§6.4, H-12).
 *
 * The list is enough to see what a run is doing; this is what answers "why". Everything here was
 * already known by the harness or measured by the engine plugin — the tool timeline, the files, the
 * evidence, what it cost — and the actions are the ones the audit asks a supervisor for: open the
 * session, steer it, or do the task again, optionally on another model.
 */
export const RunTaskDetail: Component<RunTaskDetailProps> = (props) => {
  const [steer, setSteer] = createSignal("")
  const [retryKey, setRetryKey] = createSignal(modelKey(props.task.model))

  const facts = () => {
    const task = props.task
    return [
      task.kind === "verify" ? t("verify") : task.agent,
      (task.attempt ?? 1) > 1 ? t("attempt {n}", { n: task.attempt! }) : undefined,
      task.startedAt ? elapsed(task.startedAt, task.finishedAt) : undefined,
      thousands(task.tokens) ? t("{n} tokens", { n: thousands(task.tokens)! }) : undefined,
      task.cost ? money(task.cost) : undefined,
    ].filter((value): value is string => !!value)
  }

  // Newest first: the last thing it did is what a reader looks for, and the timeline can be long.
  const calls = createMemo(() => [...(props.tools?.calls ?? [])].reverse())
  const runModels = createMemo(() =>
    props.models.map((model) => ({ key: `${model.providerID}/${model.id}`, label: `${model.providerID}/${model.id}` })),
  )

  const retry = () => {
    const key = retryKey()
    const chosen = props.models.find((model) => `${model.providerID}/${model.id}` === key)
    // The task's own model means "do it again the same way", which is the default and needs no override.
    if (!chosen || key === modelKey(props.task.model)) return props.onRetry(props.task.id)
    props.onRetry(props.task.id, { providerID: chosen.providerID, id: chosen.id })
  }

  const sendSteer = () => {
    const text = steer().trim()
    if (!text) return
    props.onSteer(props.task.id, text)
    setSteer("")
  }

  return (
    <aside class="fc-run-detail" aria-label={t("Task detail")}>
      <header class="fc-run-detail-head">
        <span class="fc-run-mark" data-status={props.task.status}>
          {marks[props.task.status]}
        </span>
        <span class="fc-run-detail-title">{props.task.name}</span>
        <button class="fc-icon-button" type="button" aria-label={t("Close")} title={t("Close")} onClick={props.onClose}>
          ×
        </button>
      </header>

      <p class="fc-run-meta">{facts().join(" · ")}</p>

      <Show when={props.activity}>
        {(doing) => (
          <p class="fc-run-doing" title={doing().detail}>
            <span class="fc-run-doing-tool">{doing().tool ?? t("working")}</span>
            <Show when={doing().detail}>
              <span class="fc-run-doing-detail">{doing().detail}</span>
            </Show>
          </p>
        )}
      </Show>

      <Show when={props.task.error}>{(error) => <p class="fc-run-error">{error()}</p>}</Show>

      <div class="fc-run-detail-actions">
        <Show when={props.task.sessionID}>
          {(id) => (
            <button class="fc-button" type="button" onClick={() => props.onOpenSession(id())}>
              {t("Open session")}
            </button>
          )}
        </Show>
        <button class="fc-button" type="button" disabled={!props.serverAvailable} onClick={retry}>
          {t("Retry")}
        </button>
        <select
          class="fc-run-detail-model"
          aria-label={t("Model for the retry")}
          value={retryKey()}
          onChange={(event) => setRetryKey(event.currentTarget.value)}
        >
          <option value={modelKey(props.task.model)}>{t("The task's own model")}</option>
          <For each={runModels()}>{(model) => <option value={model.key}>{model.label}</option>}</For>
        </select>
      </div>

      <Show when={props.task.sessionID}>
        <div class="fc-run-detail-steer">
          <input
            type="text"
            value={steer()}
            placeholder={t("Send it a message while it works…")}
            disabled={!props.serverAvailable}
            onInput={(event) => setSteer(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") sendSteer()
            }}
          />
          <button class="fc-button" type="button" disabled={!props.serverAvailable || !steer().trim()} onClick={sendSteer}>
            {t("Send")}
          </button>
        </div>
      </Show>

      <Show when={calls().length > 0}>
        <section class="fc-run-detail-section">
          <h3>{t("Tools")}</h3>
          <ol class="fc-run-detail-calls">
            <For each={calls()}>
              {(call) => (
                <li>
                  <span class="fc-run-detail-call-name">{call.tool}</span>
                  <span class="fc-run-detail-call-time">{call.ms === undefined ? "—" : duration(call.ms)}</span>
                </li>
              )}
            </For>
          </ol>
        </section>
      </Show>

      <Show when={props.touched}>
        {(changed) => (
          <section class="fc-run-detail-section">
            <h3>{t("Checkpoint")}</h3>
            <p class="fc-run-detail-note">{changed().title}</p>
            <Show when={changed().summary}>
              {(summary) => <pre class="fc-run-detail-pre">{summary()}</pre>}
            </Show>
            <Show when={changed().files.length > 0}>
              <ul class="fc-artifact-list">
                <For each={changed().files}>
                  {(file) => (
                    <li class="fc-artifact-row">
                      <span class="fc-diff-status">
                        {file.status === "added" ? "+" : file.status === "deleted" ? "−" : "~"}
                      </span>
                      <span class="fc-artifact-path">{file.path}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <button class="fc-button" type="button" onClick={() => props.onOpenChanges(props.run.directory)}>
              {t("Open checkpoints")}
            </button>
          </section>
        )}
      </Show>

      <Show when={props.task.kind === "verify" && props.task.output}>
        {(evidence) => (
          <section class="fc-run-detail-section">
            <h3>{t("Evidence")}</h3>
            <pre class="fc-run-detail-pre">{evidence()}</pre>
          </section>
        )}
      </Show>

      <Show when={props.artifacts.length > 0}>
        <section class="fc-run-detail-section">
          <h3>{t("Artifacts")}</h3>
          <For each={props.artifacts}>
            {(artifact) => (
              <div class="fc-run-detail-artifact">
                <span class="fc-artifact-kind">{t(artifact.kind)}</span>
                <span class="fc-run-detail-note">{artifact.title}</span>
              </div>
            )}
          </For>
        </section>
      </Show>
    </aside>
  )
}
