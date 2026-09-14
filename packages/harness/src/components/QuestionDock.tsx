import { For, Show, createSignal, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import type { QuestionV2Request } from "../engine-types"
import { t } from "../i18n"

type QuestionDockProps = {
  request: QuestionV2Request
  busy: boolean
  onReply: (answers: string[][]) => void
  onReject: () => void
}

export const QuestionDock: Component<QuestionDockProps> = (props) => {
  const [selected, setSelected] = createStore<string[][]>(props.request.questions.map(() => []))
  const [custom, setCustom] = createStore<string[]>(props.request.questions.map(() => ""))
  const [other, setOther] = createStore<boolean[]>(props.request.questions.map(() => false))
  const [collapsed, setCollapsed] = createSignal(false)
  const [step, setStep] = createSignal(0)

  const total = () => props.request.questions.length
  const active = () => props.request.questions[step()]
  const last = () => step() >= total() - 1

  const toggle = (questionIndex: number, label: string, multiple?: boolean) => {
    const current = selected[questionIndex] ?? []
    if (multiple) {
      setSelected(
        questionIndex,
        current.includes(label) ? current.filter((value) => value !== label) : [...current, label],
      )
      return
    }
    setSelected(questionIndex, [label])
    setOther(questionIndex, false)
  }

  // "Other" is always the last option; picking it reveals the free-text input and, on a single
  // choice, clears the listed options so only one answer is sent.
  const toggleOther = (questionIndex: number, multiple?: boolean) => {
    const next = !other[questionIndex]
    setOther(questionIndex, next)
    if (next && !multiple) setSelected(questionIndex, [])
  }

  const answers = () =>
    props.request.questions.map((_, index) => {
      const values = [...(selected[index] ?? [])]
      const extra = other[index] ? custom[index]?.trim() : ""
      if (extra) values.push(extra)
      return values
    })

  const canSubmit = () => answers().every((values) => values.length > 0)

  const answered = (index: number) => (answers()[index]?.length ?? 0) > 0

  // Skipping settles the question with no answer so the agent keeps going: the tool reports it back
  // as "Unanswered" instead of failing.
  const skip = () => props.onReply(props.request.questions.map(() => []))

  const back = () => {
    if (step() > 0) setStep(step() - 1)
  }

  // Steps are gated on their own answer so the request is only ever submitted once every question is
  // settled; going back keeps the earlier answers intact.
  const next = () => {
    if (!answered(step())) return
    if (last()) {
      if (canSubmit()) props.onReply(answers())
      return
    }
    setStep(step() + 1)
  }

  return (
    <div class="fc-dock fc-dock-question">
      <div class="fc-dock-header">
        <span class="fc-dock-title">
          {t("Question")}
          <Show when={total() > 1}>
            <span class="fc-dock-step">
              {" · "}
              {step() + 1}/{total()}
            </span>
          </Show>
        </span>
        <Show when={collapsed()}>
          <span class="fc-dock-preview">
            {props.request.questions.map((question) => question.question).join(" · ")}
          </span>
        </Show>
        <div class="fc-dock-controls">
          <button
            class="fc-dock-control"
            type="button"
            aria-expanded={!collapsed()}
            title={t(collapsed() ? "Expand" : "Collapse")}
            aria-label={t(collapsed() ? "Expand" : "Collapse")}
            onClick={() => setCollapsed((value) => !value)}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d={collapsed() ? "M9 6l6 6-6 6" : "M6 9l6 6 6-6"}
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <button
            class="fc-dock-control"
            type="button"
            disabled={props.busy}
            title={t("Dismiss")}
            aria-label={t("Dismiss")}
            onClick={props.onReject}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
      </div>
      <Show when={!collapsed()}>
        <Show when={active()}>
          {(question) => (
            <div class="fc-question">
              <div class="fc-question-header">{question().header}</div>
              <div class="fc-question-text">{question().question}</div>
              <div class="fc-question-options">
                <For each={question().options}>
                  {(option) => (
                    <button
                      class="fc-option"
                      classList={{ "fc-option-selected": (selected[step()] ?? []).includes(option.label) }}
                      type="button"
                      onClick={() => toggle(step(), option.label, question().multiple)}
                    >
                      <span class="fc-option-label">{option.label}</span>
                      <span class="fc-option-desc">{option.description}</span>
                    </button>
                  )}
                </For>
                <Show when={question().custom !== false}>
                  <button
                    class="fc-option"
                    classList={{ "fc-option-selected": other[step()] }}
                    type="button"
                    onClick={() => toggleOther(step(), question().multiple)}
                  >
                    <span class="fc-option-label">{t("Other")}</span>
                    <span class="fc-option-desc">{t("Type your own answer")}</span>
                  </button>
                </Show>
              </div>
              <Show when={other[step()]}>
                <input
                  class="fc-question-custom"
                  placeholder={t("Custom answer")}
                  value={custom[step()] ?? ""}
                  onInput={(event) => setCustom(step(), event.currentTarget.value)}
                />
              </Show>
            </div>
          )}
        </Show>
        <div class="fc-dock-actions">
          <Show when={step() > 0}>
            <button class="fc-button" type="button" disabled={props.busy} onClick={back}>
              {t("Previous")}
            </button>
          </Show>
          <button
            class="fc-button fc-button-primary"
            type="button"
            disabled={props.busy || !answered(step())}
            onClick={next}
          >
            {t(last() ? "Respond" : "Next")}
          </button>
          <button class="fc-button" type="button" disabled={props.busy} onClick={skip}>
            {t("Skip")}
          </button>
        </div>
      </Show>
    </div>
  )
}
