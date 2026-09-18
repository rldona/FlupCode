import { For, Show, createEffect, createSignal, on, type Component } from "solid-js"
import { t } from "../i18n"
import { compareRuns, type RunSnapshot } from "../compare"
import type { Run } from "../types"

type ComparePanelProps = {
  open: boolean
  runs: Run[]
  /** The pair a best-of-n landed on (H-44), picked as soon as the panel opens. */
  initialLeft?: string
  initialRight?: string
  /** Everything the comparison needs about one run: itself, its tasks and what they changed. */
  onLoad: (id: string) => Promise<RunSnapshot>
  onClose: () => void
}

/**
 * Two runs, side by side (H-33).
 *
 * The audit asks for tokens, cost, duration, files and verdict next to each other, and calls it the
 * base for best-of-n without building best-of-n. Every number comes from the server; the panel only
 * picks the two runs and puts the arithmetic in front of the reader.
 */
export const ComparePanel: Component<ComparePanelProps> = (props) => {
  const [leftID, setLeftID] = createSignal<string>()
  const [rightID, setRightID] = createSignal<string>()
  const [left, setLeft] = createSignal<RunSnapshot>()
  const [right, setRight] = createSignal<RunSnapshot>()
  const [loading, setLoading] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()

  const pick = async (side: "left" | "right", id: string) => {
    if (!id) return
    if (side === "left") setLeftID(id)
    else setRightID(id)
    setLoading(true)
    setProblem(undefined)
    try {
      const snapshot = await props.onLoad(id)
      if (side === "left") setLeft(snapshot)
      else setRight(snapshot)
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  const rows = () => {
    const a = left()
    const b = right()
    return a && b ? compareRuns(a, b) : []
  }

  // A best-of-n opens this panel with its first two runs already chosen (H-44). An ordinary visit
  // has no pair and the reader picks, exactly as before.
  createEffect(
    on(
      () => [props.open, props.initialLeft, props.initialRight] as const,
      ([open, presetLeft, presetRight]) => {
        if (!open || !presetLeft) return
        void pick("left", presetLeft)
        if (presetRight) void pick("right", presetRight)
      },
    ),
  )

  const picker = (side: "left" | "right", value: () => string | undefined) => (
    <select
      class="fc-question-custom"
      aria-label={side === "left" ? t("First run") : t("Second run")}
      value={value() ?? ""}
      onChange={(event) => void pick(side, event.currentTarget.value)}
    >
      <option value="">{t("Pick a run")}</option>
      <For each={props.runs}>
        {(run) => (
          <option value={run.id}>
            {run.id.slice(0, 8)} — {run.status}
            {run.directory ? ` · ${run.directory.split("/").at(-1)}` : ""}
          </option>
        )}
      </For>
    </select>
  )

  return (
    <Show when={props.open}>
      <section class="fc-routines-screen" aria-label={t("Compare")}>
        <div class="fc-routines-header">
          <div>
            <div class="fc-routines-kicker">{t("Session OS")}</div>
            <h1>{t("Compare")}</h1>
            <p>{t("Two runs against each other: what they spent, how long, what they touched, what the check said — and the context each was given.")}</p>
          </div>
          <div class="fc-routines-header-actions">
            <button class="fc-button" type="button" onClick={props.onClose}>
              {t("Back to sessions")}
            </button>
          </div>
        </div>

        <Show when={problem()}>{(text) => <p class="fc-run-error">{text()}</p>}</Show>

        <Show
          when={props.runs.length > 0}
          fallback={<p class="fc-usage-note">{t("No runs to compare yet.")}</p>}
        >
          <div class="fc-compare-pickers">
            <label class="fc-field">
              <span>{t("First run")}</span>
              {picker("left", leftID)}
            </label>
            <label class="fc-field">
              <span>{t("Second run")}</span>
              {picker("right", rightID)}
            </label>
          </div>

          <Show
            when={left() && right()}
            fallback={<p class="fc-usage-note">{loading() ? t("Reading…") : t("Pick two runs to compare them.")}</p>}
          >
            <table class="fc-compare-table">
              <thead>
                <tr>
                  <th scope="col">{t("What")}</th>
                  <th scope="col">{leftID()?.slice(0, 8)}</th>
                  <th scope="col">{rightID()?.slice(0, 8)}</th>
                  <th scope="col">{t("Difference")}</th>
                </tr>
              </thead>
              <tbody>
                <For each={rows()}>
                  {(row) => (
                    <tr>
                      <th scope="row">{t(row.label)}</th>
                      <td>{row.a}</td>
                      <td>{row.b}</td>
                      <td class="fc-compare-delta">{row.delta ?? ""}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>

            <div class="fc-compare-files">
              <Show
                when={left()!.files.length + right()!.files.length > 0}
                fallback={<p class="fc-usage-note">{t("Neither changed a file.")}</p>}
              >
                <p class="fc-usage-note">
                  {t("{left} files on the left, {right} on the right, {shared} in both.", {
                    left: left()!.files.length,
                    right: right()!.files.length,
                    shared: left()!.files.filter((file) => right()!.files.includes(file)).length,
                  })}
                </p>
              </Show>
            </div>
          </Show>
        </Show>
      </section>
    </Show>
  )
}
