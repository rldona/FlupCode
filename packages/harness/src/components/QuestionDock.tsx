import { For, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import type { QuestionV2Request } from "@opencode-ai/client"

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
    <div class="oh-dock oh-dock-question">
      <div class="oh-dock-header">
        <span class="oh-dock-title">Pregunta</span>
      </div>
      <For each={props.request.questions}>
        {(question, index) => (
          <div class="oh-question">
            <div class="oh-question-header">{question.header}</div>
            <div class="oh-question-text">{question.question}</div>
            <div class="oh-question-options">
              <For each={question.options}>
                {(option) => (
                  <button
                    class="oh-option"
                    classList={{ "oh-option-selected": (selected[index()] ?? []).includes(option.label) }}
                    type="button"
                    onClick={() => toggle(index(), option.label, question.multiple)}
                  >
                    <span class="oh-option-label">{option.label}</span>
                    <span class="oh-option-desc">{option.description}</span>
                  </button>
                )}
              </For>
            </div>
            <Show when={question.custom}>
              <input
                class="oh-question-custom"
                placeholder="Respuesta personalizada"
                value={custom[index()] ?? ""}
                onInput={(event) => setCustom(index(), event.currentTarget.value)}
              />
            </Show>
          </div>
        )}
      </For>
      <div class="oh-dock-actions">
        <button
          class="oh-button oh-button-primary"
          type="button"
          disabled={props.busy || !canSubmit()}
          onClick={() => props.onReply(answers())}
        >
          Responder
        </button>
        <button class="oh-button oh-button-danger" type="button" disabled={props.busy} onClick={props.onReject}>
          Rechazar
        </button>
      </div>
    </div>
  )
}
