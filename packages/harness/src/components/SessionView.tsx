import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import type {
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "../engine-types"
import { t } from "../i18n"
import { diffLines, escapeHtml, highlight, highlightDiff, sideBySideDiff } from "../highlight"
import { Loader } from "./Loader"
import { Markdown } from "./Markdown"

type SessionViewProps = {
  messages: SessionMessageInfo[] | undefined
  loading: boolean
  busy: boolean
  usage?: { tokens?: { input: number; output: number; reasoning: number }; cost?: number }
  startedAt?: number
  modelName?: (ref: { providerID: string; id: string }) => string
  liveText?: string
  liveReasoning?: string
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

function toolInput(tool: SessionMessageAssistantTool): Record<string, unknown> {
  if (tool.state.status === "pending") return {}
  return tool.state.input as Record<string, unknown>
}

function stringField(input: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string") return value
  }
  return undefined
}

const EXT_LANG: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  json: "json",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  md: "markdown",
  sql: "sql",
  xml: "xml",
}

function languageFor(path: string | undefined) {
  const extension = path ? /\.([a-zA-Z0-9]+)$/.exec(path)?.[1]?.toLowerCase() : undefined
  return extension ? (EXT_LANG[extension] ?? "") : ""
}

function toolTitle(tool: SessionMessageAssistantTool) {
  const input = toolInput(tool)
  if (tool.name === "bash") return stringField(input, "command")
  if (tool.name === "webfetch") return stringField(input, "url")
  if (tool.name === "edit" || tool.name === "write" || tool.name === "read" || tool.name === "multiedit")
    return stringField(input, "filePath", "file")
  if (tool.name === "grep" || tool.name === "glob") return stringField(input, "pattern", "query")
  if (tool.name === "websearch") return stringField(input, "query")
  if (tool.name === "task") return stringField(input, "description", "prompt")
  return undefined
}

function formatThoughtDuration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

const ReasoningBlock: Component<{ part: SessionMessageAssistantReasoning; streaming: boolean }> = (props) => {
  const [open, setOpen] = createSignal(false)
  const completed = () => !props.streaming || props.part.time?.completed !== undefined
  const duration = () => {
    const time = props.part.time
    if (!time?.completed) return undefined
    return formatThoughtDuration(time.completed - time.created)
  }
  return (
    <div class="fc-reasoning">
      <button class="fc-reasoning-toggle" type="button" onClick={() => setOpen((value) => !value)}>
        <Show
          when={!completed()}
          fallback={<span class="fc-thought-mark">{open() ? "−" : "+"}</span>}
        >
          <span class="fc-thought-spinner" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </Show>
        <span class="fc-thought-label">{completed() ? t("Thought") : t("Thinking")}</span>
        <Show when={duration()}>
          <span class="fc-thought-sep">:</span>
          <span class="fc-thought-time">{duration()}</span>
        </Show>
      </button>
      <Show when={open()}>
        <div class="fc-reasoning-text">{props.part.text}</div>
      </Show>
    </div>
  )
}

const DiffView: Component<{ oldText: string; newText: string; lang: string }> = (props) => {
  const rows = createMemo(() => sideBySideDiff(props.oldText, props.newText))
  const huge = () => rows().length > 400 || props.oldText.length + props.newText.length > 120_000
  const unified = () =>
    diffLines(props.oldText, props.newText)
      .map((line) => `${line.type === "add" ? "+" : line.type === "del" ? "-" : " "}${line.text}`)
      .join("\n")
  const cell = (value: { no?: number; text: string; kind: "same" | "del" | "add" } | undefined, kind?: string) => (
    <div class={`fc-diff2-cell fc-diff2-${kind ?? "empty"}`}>
      <span class="fc-diff2-no">{value?.no ?? ""}</span>
      <span class="fc-diff2-sign">{kind === "del" ? "-" : kind === "add" ? "+" : " "}</span>
      <span
        class="fc-diff2-code"
        innerHTML={value ? (props.lang ? highlight(value.text, props.lang) : escapeHtml(value.text)) : ""}
      />
    </div>
  )
  return (
    <Show
      when={!huge()}
      fallback={
        <pre class="fc-diff-view" innerHTML={highlightDiff(unified())} />
      }
    >
      <div class="fc-diff2">
        <For each={rows()}>
          {(row) => (
            <div class="fc-diff2-row">
              {cell(row.left, row.left?.kind)}
              {cell(row.right, row.right?.kind)}
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

const ToolOutput: Component<{ text: string; maxLines?: number }> = (props) => {
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => props.text.replace(/\n+$/, "").split("\n"))
  const cap = () => props.maxLines ?? 10
  const truncated = () => lines().length > cap()
  const visible = () => (expanded() || !truncated() ? lines().join("\n") : lines().slice(0, cap()).join("\n"))
  return (
    <div class="fc-tool-output-wrap">
      <pre class="fc-tool-output">
        {visible()}
        {truncated() && !expanded() ? "\n…" : ""}
      </pre>
      <Show when={truncated()}>
        <button class="fc-tool-expand" type="button" onClick={() => setExpanded((value) => !value)}>
          {expanded() ? t("Click to collapse") : t("Click to expand")}
        </button>
      </Show>
    </div>
  )
}

const ToolCall: Component<{ part: SessionMessageAssistantTool; live: boolean }> = (props) => {
  const [open, setOpen] = createSignal(
    props.live &&
      (props.part.state.status === "error" ||
        props.part.name === "write" ||
        props.part.name === "edit" ||
        props.part.name === "multiedit" ||
        props.part.name === "bash"),
  )
  const input = createMemo(() => toolInput(props.part))
  const output = () => toolOutput(props.part)
  const status = () => props.part.state.status
  const command = createMemo(() => stringField(input(), "command"))
  const path = createMemo(() => stringField(input(), "filePath", "file"))
  const writeContent = createMemo(() => stringField(input(), "content"))
  const oldText = createMemo(() => stringField(input(), "oldString", "old_string"))
  const newText = createMemo(() => stringField(input(), "newString", "new_string"))
  const hasDiff = () => oldText() !== undefined && newText() !== undefined
  return (
    <div class="fc-tool" classList={{ "fc-tool-failed": status() === "error" }}>
      <button class="fc-tool-header" type="button" onClick={() => setOpen((value) => !value)}>
        <span class="fc-tool-chevron">{open() ? "▾" : "▸"}</span>
        <span class="fc-tool-name">{props.part.name}</span>
        <Show when={toolTitle(props.part)}>{(value) => <span class="fc-tool-title">{value()}</span>}</Show>
        <span class={`fc-tool-status fc-tool-status-${status()}`}>{status()}</span>
      </button>
      <Show when={open()}>
        <div class="fc-tool-body">
          <Show when={hasDiff()}>
            <DiffView oldText={oldText() ?? ""} newText={newText() ?? ""} lang={languageFor(path())} />
          </Show>
          <Show when={props.part.name === "write" && writeContent() !== undefined}>
            <pre class="fc-code" innerHTML={highlight(writeContent() ?? "", languageFor(path()))} />
          </Show>
          <Show when={command() !== undefined}>
            <pre class="fc-tool-cmd">$ {command()}</pre>
          </Show>
          <Show when={output()}>
            <ToolOutput text={output()} />
          </Show>
        </div>
      </Show>
    </div>
  )
}

function formatDuration(ms: number) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function turnStart(messages: SessionMessageInfo[], index: number) {
  let start = index
  while (start > 0 && messages[start - 1]?.type === "assistant") start--
  return start
}

function turnCommit(messages: SessionMessageInfo[], index: number) {
  const start = turnStart(messages, index)
  for (let cursor = index; cursor >= start; cursor--) {
    const message = messages[cursor]
    if (message?.type !== "assistant") continue
    for (const part of (message as SessionMessageAssistant).content) {
      if (part.type === "text") {
        const match = /(?:commit|committed)[^\n]{0,40}?\b([0-9a-f]{7,40})\b/i.exec(part.text ?? "")
        if (match?.[1]) return { hash: match[1], inText: true }
      }
      if (part.type === "tool" && part.name === "bash") {
        const text = toolOutput(part)
        const match = /\b([0-9a-f]{7,40})\b/.exec(text ?? "")
        if (match?.[1] && /commit/i.test(text ?? "")) return { hash: match[1], inText: false }
      }
    }
  }
  return undefined
}

const TurnFooter: Component<{
  agent: string
  model?: { providerID: string; id: string }
  duration?: string
  commit?: { hash: string; inText: boolean }
  modelName?: (ref: { providerID: string; id: string }) => string
}> = (props) => {
  const model = () => {
    if (!props.model) return undefined
    return props.modelName?.(props.model) ?? props.model.id
  }
  return (
    <div class="fc-turn">
      <Show when={props.commit && !props.commit.inText}>
        <div class="fc-turn-commit">
          {t("Commit")}: <code>{props.commit!.hash}</code>
        </div>
      </Show>
      <div class="fc-turn-footer">
        <span class="fc-turn-icon">▣</span>
        <span>{props.agent}</span>
        <Show when={model()}>
          <span class="fc-turn-sep">·</span>
          <span>{model()}</span>
        </Show>
        <Show when={props.duration}>
          <span class="fc-turn-sep">·</span>
          <span>{props.duration}</span>
        </Show>
      </div>
    </div>
  )
}

const AssistantMessage: Component<{
  message: SessionMessageAssistant
  showTools: boolean
  showRole: boolean
  live: boolean
  streaming: boolean
}> = (
  props,
) => (
  <div class="fc-message fc-message-assistant">
    <Show when={props.showRole}>
      <div class="fc-message-role">{props.message.agent}</div>
    </Show>
    <For each={props.message.content}>
      {(part) => (
        <Show when={props.showTools || part.type !== "tool"}>
          <Show
            when={part.type === "tool"}
            fallback={
              <Show
                when={part.type === "reasoning"}
                fallback={<Markdown class="fc-message-text" text={(part as SessionMessageAssistantText).text} />}
              >
                <ReasoningBlock part={part as SessionMessageAssistantReasoning} streaming={props.streaming} />
              </Show>
            }
          >
            <ToolCall part={part as SessionMessageAssistantTool} live={props.live} />
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

  const turnMeta = (index: number) => {
    const list = props.messages ?? []
    const start = turnStart(list, index)
    const first = list[start] as SessionMessageAssistant
    const last = list[index] as SessionMessageAssistant
    const created = first.time?.created
    const completed = last.time?.completed
    return {
      agent: last.agent,
      model: last.model,
      duration: created && completed ? formatDuration(completed - created) : undefined,
    }
  }

  const isTurnEnd = (index: number) => {
    const next = props.messages?.[index + 1]
    if (next?.type === "assistant") return false
    if (!next) return !props.busy
    return true
  }

  const lastTurnStart = createMemo(() => {
    const list = props.messages ?? []
    let index = list.length - 1
    while (index >= 0 && list[index]?.type !== "assistant") index--
    while (index > 0 && list[index - 1]?.type === "assistant") index--
    return index
  })

  const [visibleCount, setVisibleCount] = createSignal(80)
  let firstMessageID: string | undefined
  const total = () => props.messages?.length ?? 0
  const offset = () => Math.max(0, total() - visibleCount())
  const visibleMessages = () => (props.messages ?? []).slice(offset())
  const fullIndex = (index: number) => offset() + index

  let body: HTMLDivElement | undefined
  let lastScrollTop = 0
  // When the reader last touched the transcript (wheel, touch, keys, scrollbar).
  let readerInput = 0
  const markReaderInput = () => {
    readerInput = performance.now()
  }
  const scrollToBottom = () => {
    if (container) container.scrollTop = container.scrollHeight
  }

  // Follows the end while content grows (streaming, tool output, refreshed history). The body only
  // exists once the transcript has loaded and is recreated on reload, so it is observed from its ref.
  const growth = new ResizeObserver(() => {
    if (stick()) requestAnimationFrame(scrollToBottom)
  })
  onCleanup(() => growth.disconnect())
  const observeBody = (element: HTMLDivElement) => {
    if (body) growth.unobserve(body)
    body = element
    growth.observe(element)
  }

  createEffect(() => {
    const first = props.messages?.[0]?.id
    props.busy
    const switched = first !== firstMessageID
    if (switched) {
      firstMessageID = first
      setVisibleCount(80)
      setStick(true)
    }
    if (!stick()) return
    requestAnimationFrame(scrollToBottom)
    const timers = [setTimeout(scrollToBottom, 80), setTimeout(scrollToBottom, 320)]
    onCleanup(() => timers.forEach((timer) => clearTimeout(timer)))
  })

  return (
    <section
      class="fc-transcript"
      ref={container}
      onScroll={() => {
        if (!container) return
        const distance = container.scrollHeight - container.scrollTop - container.clientHeight
        const movedUp = container.scrollTop < lastScrollTop
        lastScrollTop = container.scrollTop
        // Only the reader scrolling up leaves the end; content changing height never does.
        if (distance < 120) setStick(true)
        else if (movedUp && performance.now() - readerInput < 1000) setStick(false)
      }}
      onWheel={markReaderInput}
      onTouchMove={markReaderInput}
      onPointerDown={markReaderInput}
      onKeyDown={markReaderInput}
    >
      <Show
        when={!props.loading || (props.messages?.length ?? 0) > 0}
        fallback={
          <div class="fc-loading-center">
            <Loader />
          </div>
        }
      >
        <div class="fc-transcript-body" ref={observeBody}>
        <Show
          when={props.messages && props.messages.length > 0}
          fallback={
            <div class="fc-empty-state">
              <span class="fc-empty-title">{t("No messages yet")}</span>
              <span class="fc-empty-hint">{t("Write below to start")}</span>
            </div>
          }
        >
          <Show when={offset() > 0}>
            <button
              class="fc-load-earlier"
              type="button"
              onClick={() => {
                setStick(false)
                setVisibleCount((value) => value + 80)
              }}
            >
              {t("Load earlier messages")}
            </button>
          </Show>
          <For each={visibleMessages()}>
            {(message, index) => (
              <Show
                when={message.type === "user"}
                fallback={
                  <Show when={message.type === "assistant"}>
                    <AssistantMessage
                      message={message as SessionMessageAssistant}
                      showTools={props.showTools}
                      showRole={fullIndex(index()) === 0 || props.messages?.[fullIndex(index()) - 1]?.type !== "assistant"}
                      live={fullIndex(index()) >= lastTurnStart()}
                      streaming={props.busy && fullIndex(index()) === (props.messages?.length ?? 0) - 1}
                    />
                    <Show when={isTurnEnd(fullIndex(index()))}>
                      <TurnFooter
                        {...turnMeta(fullIndex(index()))}
                        commit={turnCommit(props.messages ?? [], fullIndex(index()))}
                        modelName={props.modelName}
                      />
                    </Show>
                  </Show>
                }
              >
                <div class="fc-message fc-message-user">
                <div class="fc-message-role">{t("You")}</div>
                <Markdown class="fc-message-text" text={(message as { text?: string }).text ?? ""} />
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
          <Show when={props.busy && (props.liveText || props.liveReasoning)}>
            <div class="fc-message fc-message-assistant fc-message-live">
              <Show when={props.liveReasoning}>
                <div class="fc-reasoning-text">{props.liveReasoning}</div>
              </Show>
              <Show when={props.liveText}>
                <Markdown class="fc-message-text" text={props.liveText ?? ""} />
              </Show>
            </div>
          </Show>
          <Show when={props.busy}>
            <div class="fc-message fc-message-assistant fc-message-pending">
              <Loader tokens={props.usage?.tokens} cost={props.usage?.cost} startedAt={props.startedAt} />
            </div>
          </Show>
        </Show>
        </div>
      </Show>
    </section>
  )
}
