import { For, Show, createSignal, type Component } from "solid-js"
import type {
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode-ai/client"

type SessionViewProps = {
  messages: SessionMessageInfo[] | undefined
  loading: boolean
  busy: boolean
  showTools: boolean
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
  if (tool.state.status === "running") return "En ejecución…"
  return "Pendiente…"
}

const ReasoningBlock: Component<{ part: SessionMessageAssistantReasoning }> = (props) => {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="oh-reasoning">
      <button class="oh-reasoning-toggle" type="button" onClick={() => setOpen((value) => !value)}>
        {open() ? "▾" : "▸"} Pensamiento
      </button>
      <Show when={open()}>
        <div class="oh-reasoning-text">{props.part.text}</div>
      </Show>
    </div>
  )
}

const ToolCall: Component<{ part: SessionMessageAssistantTool }> = (props) => {
  const [open, setOpen] = createSignal(false)
  const output = () => toolOutput(props.part)
  return (
    <div class="oh-tool">
      <button class="oh-tool-header" type="button" onClick={() => setOpen((value) => !value)}>
        <span class="oh-tool-name">{props.part.name}</span>
        <span class="oh-tool-status">{props.part.state.status}</span>
      </button>
      <Show when={open() && output()}>
        <pre class="oh-tool-output">{output()}</pre>
      </Show>
    </div>
  )
}

const AssistantMessage: Component<{ message: SessionMessageAssistant; showTools: boolean }> = (props) => (
  <div class="oh-message oh-message-assistant">
    <div class="oh-message-role">{props.message.agent}</div>
    <For each={props.message.content}>
      {(part) => (
        <Show when={props.showTools || part.type !== "tool"}>
          <Show
            when={part.type === "tool"}
            fallback={
              <Show
                when={part.type === "reasoning"}
                fallback={<div class="oh-message-text">{(part as SessionMessageAssistantText).text}</div>}
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
      <div class="oh-message-error">Error al generar la respuesta</div>
    </Show>
  </div>
)

export const SessionView: Component<SessionViewProps> = (props) => (
  <section class="oh-transcript">
    <Show
      when={!props.loading}
      fallback={
        <div class="oh-skeleton-list">
          <div class="oh-skeleton" />
          <div class="oh-skeleton" />
          <div class="oh-skeleton" />
        </div>
      }
    >
      <Show
        when={props.messages && props.messages.length > 0}
        fallback={
          <div class="oh-empty-state">
            <span class="oh-empty-title">Aún no hay mensajes</span>
            <span class="oh-empty-hint">Escribe abajo para empezar</span>
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
              <div class="oh-message oh-message-user">
                <div class="oh-message-role">Tú</div>
                <div class="oh-message-text">{(message as { text?: string }).text}</div>
              </div>
            </Show>
          )}
        </For>
        <Show when={props.busy}>
          <div class="oh-message oh-message-assistant oh-message-pending">Generando…</div>
        </Show>
      </Show>
    </Show>
  </section>
)
