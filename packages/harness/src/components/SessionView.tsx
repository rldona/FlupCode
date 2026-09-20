import { For, Show, createEffect, createSignal, type Component } from "solid-js"
import type {
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "../engine-types"
import { t } from "../i18n"
import { Spinner } from "./Spinner"

type SessionViewProps = {
  messages: SessionMessageInfo[] | undefined
  loading: boolean
  busy: boolean
  showTools: boolean
  onEditUser: (messageID: string, text: string) => void
}

function toolOutput(tool: SessionMessageAssistantTool) {
  if (tool.state.status === "completed") {
    return tool.state.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n")
  }
  if (tool.state.status === "error") {
    const error = tool.state.error as { message?: string }
    return error.message ?? "Error"
  }
  if (tool.state.status === "running") return t("In progress")
  return t("Pending")
}

const ReasoningBlock: Component<{ part: SessionMessageAssistantReasoning }> = (props) => {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="fc-reasoning">
      <button class="fc-reasoning-toggle" type="button" onClick={() => setOpen((value) => !value)}>
        {open() ? "▾" : "▸"} {t("Thinking")}
      </button>
      <Show when={open()}>
        <div class="fc-reasoning-text">{props.part.text}</div>
      </Show>
    </div>
  )
}

const ToolCall: Component<{ part: SessionMessageAssistantTool }> = (props) => {
  const [open, setOpen] = createSignal(false)
  const output = () => toolOutput(props.part)
  return (
    <div class="fc-tool">
      <button class="fc-tool-header" type="button" onClick={() => setOpen((value) => !value)}>
        <span class="fc-tool-name">{props.part.name}</span>
        <span class="fc-tool-status">{props.part.state.status}</span>
      </button>
      <Show when={open() && output()}>
        <pre class="fc-tool-output">{output()}</pre>
      </Show>
    </div>
  )
}

const AssistantMessage: Component<{ message: SessionMessageAssistant; showTools: boolean }> = (props) => (
  <div class="fc-message fc-message-assistant">
    <div class="fc-message-role">{props.message.agent}</div>
    <For each={props.message.content}>
      {(part) => (
        <Show when={props.showTools || part.type !== "tool"}>
          <Show
            when={part.type === "tool"}
            fallback={
              <Show
                when={part.type === "reasoning"}
                fallback={<div class="fc-message-text">{(part as SessionMessageAssistantText).text}</div>}
              >
                <ReasoningBlock part={part as SessionMessageAssistantReasoning} />
              </Show>
            }
          >
            <ToolCall part={part as SessionMessageAssistantTool} />
          </Show>
        </Show>
      )}
    </For>
    <Show when={props.message.error}>
      <div class="fc-message-error">{t("Error generating the response")}</div>
    </Show>
  </div>
)

export const SessionView: Component<SessionViewProps> = (props) => {
  let container: HTMLElement | undefined
  const [stick, setStick] = createSignal(true)

  createEffect(() => {
    props.messages
    props.busy
    if (stick() && container) queueMicrotask(() => (container!.scrollTop = container!.scrollHeight))
  })

  createEffect(() => {
    props.messages
    setStick(true)
    if (container) queueMicrotask(() => (container!.scrollTop = container!.scrollHeight))
  })

  return (
    <section
      class="fc-transcript"
      ref={container}
      onScroll={() => {
        if (!container) return
        setStick(container.scrollHeight - container.scrollTop - container.clientHeight < 120)
      }}
    >
      <Show
        when={!props.loading}
        fallback={
          <div class="fc-skeleton-list">
            <div class="fc-skeleton" />
            <div class="fc-skeleton" />
            <div class="fc-skeleton" />
          </div>
        }
      >
        <Show
          when={props.messages && props.messages.length > 0}
          fallback={
            <div class="fc-empty-state">
              <span class="fc-empty-title">{t("No messages yet")}</span>
              <span class="fc-empty-hint">{t("Write below to start")}</span>
            </div>
          }
        >
          <For each={props.messages}>
            {(message) => (
              <Show
                when={message.type === "user"}
                fallback={
                  <Show when={message.type === "assistant"}>
                    <AssistantMessage message={message as SessionMessageAssistant} showTools={props.showTools} />
                  </Show>
                }
              >
                <div class="fc-message fc-message-user">
                  <div class="fc-message-role">{t("You")}</div>
                  <div class="fc-message-text">{(message as { text?: string }).text}</div>
                  <button
                    class="fc-message-edit"
                    type="button"
                    onClick={() => props.onEditUser(message.id, (message as { text?: string }).text ?? "")}
                  >
                    {t("Edit")}
                  </button>
                </div>
              </Show>
            )}
          </For>
          <Show when={props.busy}>
            <div class="fc-message fc-message-assistant fc-message-pending">
              <Spinner /> {t("Generating")}
            </div>
          </Show>
        </Show>
      </Show>
    </section>
  )
}
