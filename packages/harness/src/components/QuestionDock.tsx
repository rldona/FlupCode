import { For, Show, type Component } from "solid-js"
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
  }

  const answers = () =>
    props.request.questions.map((_, index) => {
      const values = [...(selected[index] ?? [])]
      const extra = custom[index]?.trim()
      if (extra) values.push(extra)
      return values
    })

  const canSubmit = () => answers().every((values) => values.length > 0)

  return (
    <div class="fc-dock fc-dock-question">
      <div class="fc-dock-header">
        <span class="fc-dock-title">{t("Question")}</span>
      </div>
      <For each={props.request.questions}>
        {(question, index) => (
          <div class="fc-question">
            <div class="fc-question-header">{question.header}</div>
            <div class="fc-question-text">{question.question}</div>
            <div class="fc-question-options">
              <For each={question.options}>
                {(option) => (
                  <button
                    class="fc-option"
                    classList={{ "fc-option-selected": (selected[index()] ?? []).includes(option.label) }}
                    type="button"
                    onClick={() => toggle(index(), option.label, question.multiple)}
                  >
                    <span class="fc-option-label">{option.label}</span>
                    <span class="fc-option-desc">{option.description}</span>
                  </button>
                )}
              </For>
            </div>
            <Show when={question.custom}>
              <input
                class="fc-question-custom"
                placeholder={t("Custom answer")}
                value={custom[index()] ?? ""}
                onInput={(event) => setCustom(index(), event.currentTarget.value)}
              />
            </Show>
          </div>
        )}
      </For>
      <div class="fc-dock-actions">
        <button
          class="fc-button fc-button-primary"
          type="button"
          disabled={props.busy || !canSubmit()}
          onClick={() => props.onReply(answers())}
        >
          {t("Respond")}
        </button>
        <button class="fc-button fc-button-danger" type="button" disabled={props.busy} onClick={props.onReject}>
          {t("Reject")}
        </button>
      </div>
    </div>
  )
}
