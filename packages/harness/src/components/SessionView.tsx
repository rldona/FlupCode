import { For, Index, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import type {
  SessionMessageAssistant,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "../engine-types"
import { t } from "../i18n"
import { openImagePreview } from "../image-preview"
import { toast } from "../toast"
import { diffLines, escapeHtml, highlight, highlightDiff, sideBySideDiff } from "../highlight"
import { Loader } from "./Loader"
import { Markdown } from "./Markdown"
import { ChapterNav, type Chapter } from "./ChapterNav"

type MessageFile = { uri: string; mime?: string; name?: string }

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
  /** Chats show no agent names (every chat runs the same one) and no Edit, which rewinds code sessions. */
  chat?: boolean
  /** Prompts sent before the engine projects their message; queued ones offer "Send now". */
  pending?: Array<{ id: string; text: string; files?: MessageFile[]; queued: boolean; sendNow?: () => void }>
  onEditUser: (messageID: string, text: string) => void
  /** Forks a new session from a prompt; omitted in the split panes and for chats. */
  onForkUser?: (messageID: string) => void
}

/** Images and file names attached to a prompt, shown above the prompt's text. */
const MessageFiles: Component<{ files?: MessageFile[] }> = (props) => (
  <Show when={(props.files?.length ?? 0) > 0}>
    <div class="fc-message-files">
      <For each={props.files ?? []}>
        {(file) => (
          <Show
            when={file.mime?.startsWith("image/") || file.uri.startsWith("data:image/")}
            fallback={<span class="fc-message-file">{file.name ?? file.uri}</span>}
          >
            <button
              class="fc-message-image-button"
              type="button"
              aria-label={t("Open image")}
              onClick={() => openImagePreview({ uri: file.uri, name: file.name })}
            >
              <img class="fc-message-image" src={file.uri} alt={file.name ?? t("Attachments")} loading="lazy" />
              <span class="fc-message-image-zoom" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="30" height="30">
                  <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2" />
                  <path d="m15.5 15.5 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                  <path d="M10.5 7.5v6M7.5 10.5h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </svg>
              </span>
            </button>
          </Show>
        )}
      </For>
    </div>
  </Show>
)

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
    <Show when={!huge()} fallback={<pre class="fc-diff-view" innerHTML={highlightDiff(unified())} />}>
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
        {/* A command speaks for itself; other tools keep their name before the title. */}
        <Show when={!(props.part.name === "bash" && toolTitle(props.part))}>
          <span class="fc-tool-name">{props.part.name}</span>
        </Show>
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

const TOOL_KINDS: Record<string, "command" | "read" | "edit" | "search" | "fetch" | "tasks"> = {
  bash: "command",
  read: "read",
  write: "edit",
  edit: "edit",
  multiedit: "edit",
  apply_patch: "edit",
  grep: "search",
  glob: "search",
  list: "search",
  websearch: "search",
  webfetch: "fetch",
  todowrite: "tasks",
}

/** Claude Code-style summary of a run of tool calls: "Read 2 files, ran a command". */
function toolGroupSummary(parts: SessionMessageAssistantTool[]) {
  const counts = new Map<string, number>()
  for (const part of parts) {
    const kind = TOOL_KINDS[part.name] ?? "other"
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const phrase = (kind: string, n: number) => {
    const one = n === 1
    switch (kind) {
      case "command":
        return one ? t("Ran a command") : t("Ran {n} commands", { n })
      case "read":
        return one ? t("Read a file") : t("Read {n} files", { n })
      case "edit":
        return one ? t("Edited a file") : t("Edited {n} files", { n })
      case "search":
        return one ? t("Searched once") : t("Searched {n} times", { n })
      case "fetch":
        return one ? t("Fetched a page") : t("Fetched {n} pages", { n })
      case "tasks":
        return t("Updated tasks")
      default:
        return one ? t("Used a tool") : t("Used {n} tools", { n })
    }
  }
  return [...counts.entries()]
    .map(([kind, n], index) => {
      const text = phrase(kind, n)
      return index === 0 ? text : text.charAt(0).toLowerCase() + text.slice(1)
    })
    .join(", ")
}

/**
 * Consecutive tool calls collapse into one line that shimmers while they run. The line opens the
 * list of calls, and each call opens its detail.
 */
const ToolGroup: Component<{ parts: SessionMessageAssistantTool[] }> = (props) => {
  const [open, setOpen] = createSignal(false)
  const running = () => props.parts.some((part) => part.state.status === "running" || part.state.status === "pending")
  const failed = () => props.parts.some((part) => part.state.status === "error")
  const done = () =>
    props.parts.filter((part) => part.state.status === "completed" || part.state.status === "error").length
  return (
    <div class="fc-toolgroup" classList={{ "fc-toolgroup-running": running(), "fc-toolgroup-open": open() }}>
      <button class="fc-toolgroup-line" type="button" aria-expanded={open()} onClick={() => setOpen((value) => !value)}>
        <span class="fc-toolgroup-label">{toolGroupSummary(props.parts)}</span>
        <span
          class="fc-toolgroup-count"
          title={t("{n} tools in this block", { n: props.parts.length })}
          aria-label={t("{n} tools in this block", { n: props.parts.length })}
        >
          {running() ? `${done()}/${props.parts.length}` : props.parts.length}
        </span>
        <Show when={failed()}>
          <span class="fc-toolgroup-failed">{t("error")}</span>
        </Show>
        <svg class="fc-toolgroup-chevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path
            d="m9 6 6 6-6 6"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <Show when={open()}>
        <div class="fc-toolgroup-list">
          <Index each={props.parts}>{(part) => <ToolCall part={part()} live={false} />}</Index>
        </div>
      </Show>
    </div>
  )
}

type AssistantSegment =
  | { kind: "part"; part: SessionMessageAssistant["content"][number] }
  | { kind: "tools"; parts: SessionMessageAssistantTool[] }

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
  hideAgent?: boolean
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
        <Show when={!props.hideAgent}>
          <span>{props.agent}</span>
        </Show>
        <Show when={model()}>
          <span>{model()}</span>
        </Show>
        <Show when={props.duration}>
          <span>{props.duration}</span>
        </Show>
      </div>
    </div>
  )
}

/**
 * A run of tool calls can span several assistant messages (each model step is one), with only
 * reasoning between them. Each run renders once, as a single line, in the message where it starts.
 */
type ToolRuns = Map<string, { first: boolean; parts: SessionMessageAssistantTool[] }>

const toolKey = (message: SessionMessageAssistant, part: SessionMessageAssistantTool) => `${message.id}:${part.id}`

function collectToolRuns(messages: SessionMessageInfo[]): ToolRuns {
  const runs: ToolRuns = new Map()
  let current: SessionMessageAssistantTool[] | undefined
  for (const message of messages) {
    if (message.type !== "assistant") {
      current = undefined
      continue
    }
    for (const part of (message as SessionMessageAssistant).content) {
      if (part.type === "reasoning") continue
      if (part.type !== "tool") {
        current = undefined
        continue
      }
      const tool = part as SessionMessageAssistantTool
      const first = !current
      if (!current) current = []
      current.push(tool)
      runs.set(toolKey(message as SessionMessageAssistant, tool), { first, parts: current })
    }
  }
  return runs
}

function assistantSegments(message: SessionMessageAssistant, showTools: boolean, runs: ToolRuns): AssistantSegment[] {
  const segments: AssistantSegment[] = []
  for (const part of message.content) {
    if (part.type === "tool") {
      if (!showTools) continue
      const run = runs.get(toolKey(message, part as SessionMessageAssistantTool))
      // Later calls of a run are drawn by the line where the run starts.
      if (run?.first) segments.push({ kind: "tools", parts: run.parts })
      else if (!run) segments.push({ kind: "tools", parts: [part as SessionMessageAssistantTool] })
      continue
    }
    // Like Claude Code, the model's reasoning stays out of the conversation; the status line says
    // "Thinking…" while it happens.
    if (part.type === "reasoning") continue
    segments.push({ kind: "part", part })
  }
  return segments
}

/** Stopping a run ends its message with an abort error, which is not a failure to show in red. */
export function stoppedByUser(error: unknown) {
  if (!error || typeof error !== "object") return false
  const { name, type, _tag } = error as { name?: unknown; type?: unknown; _tag?: unknown }
  return [name, type, _tag].some((value) => typeof value === "string" && /abort|interrupt/i.test(value))
}

const AssistantMessage: Component<{
  message: SessionMessageAssistant
  showTools: boolean
  showRole: boolean
  toolRuns: ToolRuns
}> = (props) => {
  const segments = () => assistantSegments(props.message, props.showTools, props.toolRuns)
  return (
    // A message that only continues an earlier run of tools has nothing of its own to show.
    <Show when={segments().length > 0 || props.message.error || props.showRole}>
      <div class="fc-message fc-message-assistant">
        <Show when={props.showRole}>
          <div class="fc-message-role">{props.message.agent}</div>
        </Show>
        {/* Index keeps each group mounted while the message streams, so an opened group stays open. */}
        <Index each={segments()}>
          {(segment) => (
            <Show
              when={segment().kind === "tools"}
              fallback={
                <Markdown
                  class="fc-message-text"
                  text={(segment() as { part: SessionMessageAssistantText }).part.text ?? ""}
                />
              }
            >
              <ToolGroup parts={(segment() as { parts: SessionMessageAssistantTool[] }).parts} />
            </Show>
          )}
        </Index>
        <Show when={props.message.error}>
          <Show
            when={stoppedByUser(props.message.error)}
            fallback={<div class="fc-message-error">{t("Error generating the response")}</div>}
          >
            <div class="fc-message-stopped">{t("Stopped")}</div>
          </Show>
        </Show>
      </div>
    </Show>
  )
}

export const SessionView: Component<SessionViewProps> = (props) => {
  let container: HTMLElement | undefined
  const [stick, setStick] = createSignal(true)
  // Far enough from the end to offer the "back to the end" button.
  const [awayFromEnd, setAwayFromEnd] = createSignal(false)
  const motion = () => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth")

  const copyText = (text: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => toast(t("Copied"), "success"))
      .catch(() => undefined)
  }

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

  // What the running turn is doing right now, for the status line under the conversation.
  const activity = createMemo(() => {
    const list = props.messages ?? []
    const start = Math.max(0, lastTurnStart())
    let runningTools = 0
    let lastPart: { type: string; time?: { completed?: number } } | undefined
    for (let index = start; index < list.length; index++) {
      const message = list[index]
      if (message?.type !== "assistant") continue
      for (const part of (message as SessionMessageAssistant).content) {
        if (part.type === "tool" && (part.state.status === "running" || part.state.status === "pending")) runningTools++
        lastPart = part as typeof lastPart
      }
    }
    if (runningTools > 0) return { tasks: runningTools, label: t("Running tools…") }
    if (props.liveReasoning || (lastPart?.type === "reasoning" && lastPart.time?.completed === undefined))
      return { tasks: 0, label: t("Thinking…") }
    if (props.liveText) return { tasks: 0, label: t("Writing…") }
    return { tasks: 0, label: t("Waiting for FlupCode…") }
  })

  const [visibleCount, setVisibleCount] = createSignal(80)
  let firstMessageID: string | undefined
  const total = () => props.messages?.length ?? 0
  const offset = () => Math.max(0, total() - visibleCount())
  const visibleMessages = () => (props.messages ?? []).slice(offset())
  const toolRuns = createMemo(() => collectToolRuns(visibleMessages()))
  const fullIndex = (index: number) => offset() + index

  let body: HTMLDivElement | undefined
  // When the reader last touched the transcript (wheel, touch, keys, scrollbar).
  let readerInput = 0
  const markReaderInput = () => {
    readerInput = performance.now()
  }
  // Auto-scroll is queued in a frame/timer, so it must re-check `stick` when it runs: otherwise it
  // can land after the reader has scrolled away and drag the transcript back to the bottom.
  const scrollToBottom = () => {
    if (container && stick()) container.scrollTop = container.scrollHeight
  }

  // One chapter per prompt, for the navigator at the top of the chat.
  const chapters = createMemo((): Chapter[] =>
    (props.messages ?? []).flatMap((message) => {
      if (message.type !== "user") return []
      // Prompts from other clients can carry injected <system-reminder> blocks: title by what was typed.
      const text = ((message as { text?: string }).text ?? "")
        .replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/g, "")
        .trim()
      const line = text.split("\n").find((entry) => entry.trim()) ?? ""
      return [{ id: message.id, title: line.trim().slice(0, 120) || t("Attachments") }]
    }),
  )
  const [activeChapter, setActiveChapter] = createSignal<string>()
  let jumpedTo: string | undefined
  let jumpedAt = 0
  let chapterFrame = 0
  const trackChapter = () => {
    cancelAnimationFrame(chapterFrame)
    chapterFrame = requestAnimationFrame(() => {
      if (!container || !body) return
      // A prompt picked in the navigator stays current until the reader scrolls by hand, even if
      // the chat cannot scroll far enough to bring it to the top.
      if (jumpedTo && readerInput < jumpedAt) return setActiveChapter(jumpedTo)
      jumpedTo = undefined
      // At the end the last prompt is the current one, even when its short answer leaves it low on
      // screen; otherwise it is the last prompt that has reached the upper part of the chat.
      if (container.scrollHeight - container.scrollTop - container.clientHeight < 8) {
        setActiveChapter(chapters().at(-1)?.id)
        return
      }
      const rect = container.getBoundingClientRect()
      const line = rect.top + rect.height * 0.4
      let current: string | undefined
      for (const element of body.querySelectorAll<HTMLElement>("[data-chapter]")) {
        if (element.getBoundingClientRect().top > line) break
        current = element.dataset.chapter
      }
      setActiveChapter(current ?? chapters()[0]?.id)
    })
  }
  onCleanup(() => cancelAnimationFrame(chapterFrame))
  createEffect(() => {
    chapters()
    trackChapter()
  })

  const jumpToChapter = (id: string) => {
    const index = (props.messages ?? []).findIndex((message) => message.id === id)
    if (index < 0) return
    setStick(false)
    jumpedTo = id
    jumpedAt = performance.now()
    // Render older messages first when the prompt is above the loaded window.
    if (index < offset()) setVisibleCount(total() - index + 20)
    setActiveChapter(id)
    const rendered = index >= offset()
    // Messages above render lazily (content-visibility), so their real heights shift the target
    // after the first jump: keep aligning it for a few frames until it stays put.
    let frames = 0
    const align = () => {
      const target = body?.querySelector<HTMLElement>(`[data-chapter="${CSS.escape(id)}"]`)
      if (target && container) {
        const before = target.getBoundingClientRect().top
        target.scrollIntoView({ block: "start" })
        if (Math.abs(target.getBoundingClientRect().top - before) < 1 && frames > 2) return
      }
      if (++frames < 30) requestAnimationFrame(align)
    }
    const target = rendered ? body?.querySelector<HTMLElement>(`[data-chapter="${CSS.escape(id)}"]`) : undefined
    if (!target || motion() === "auto") return requestAnimationFrame(align)
    // Glide to a prompt that is already rendered, then settle any shift from lazy rendering.
    target.scrollIntoView({ block: "start", behavior: "smooth" })
    setTimeout(() => requestAnimationFrame(align), 500)
  }

  const scrollToEnd = () => {
    if (!container) return
    // Following the end starts once the glide arrives (the scroll handler re-sticks near the end);
    // sticking now would snap there instantly and cut the animation.
    if (motion() === "auto") setStick(true)
    container.scrollTo({ top: container.scrollHeight, behavior: motion() })
  }

  // Growing content never follows on its own: streaming, tool output and refreshed history only tell
  // the "back to end" button whether the reader has fallen behind. The body exists once the
  // transcript has loaded and is recreated on reload, so it is observed from its ref.
  const growth = new ResizeObserver(() => {
    if (!container) return
    setAwayFromEnd(container.scrollHeight - container.scrollTop - container.clientHeight > 200)
  })
  onCleanup(() => growth.disconnect())
  const observeBody = (element: HTMLDivElement) => {
    if (body) growth.unobserve(body)
    body = element
    growth.observe(element)
  }

  // The conversation navigator's rail sits over the chat's left edge. Below this column width the
  // transcript and the prompt dock narrow together so neither runs under the rail; this is measured
  // from the frame, not the viewport, so an open context panel (or a resized sidebar) is accounted
  // for. See fc-chat-narrow in shell.css.
  const [chatNarrow, setChatNarrow] = createSignal(false)
  const frameWidth = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? 0
    setChatNarrow(width > 0 && width < 920)
  })
  onCleanup(() => frameWidth.disconnect())
  const observeFrame = (element: HTMLDivElement) => frameWidth.observe(element)

  // Land at the end once per session switch, once per prompt sent, and once when the turn delivers
  // its final answer; content growing below never drags the reader back in between. The delayed
  // attempts cover lazy rendering; `scrollToBottom` re-checks `stick`, so scrolling during that
  // window wins. The timers live outside the effect so a message update cannot cancel them.
  let settleTimers: Array<ReturnType<typeof setTimeout>> = []
  const clearSettleTimers = () => {
    settleTimers.forEach((timer) => clearTimeout(timer))
    settleTimers = []
  }
  onCleanup(clearSettleTimers)
  const landAtEnd = () => {
    setStick(true)
    clearSettleTimers()
    scrollToBottom()
    settleTimers = [setTimeout(scrollToBottom, 80), setTimeout(scrollToBottom, 320)]
  }
  let lastPendingID: string | undefined
  let wasBusy = false
  createEffect(() => {
    const first = props.messages?.[0]?.id
    const newest = props.pending?.at(-1)?.id
    const busy = props.busy
    const switched = first !== firstMessageID
    const sent = newest !== undefined && newest !== lastPendingID
    // The run state spans every step of a turn, so going idle means the final answer is in.
    const finished = wasBusy && !busy
    wasBusy = busy
    if (!switched && !sent && !finished) return
    firstMessageID = first
    if (sent) lastPendingID = newest
    if (switched) setVisibleCount(80)
    landAtEnd()
  })

  return (
    // The navigator and the back-to-end button float over the chat from this frame, outside the
    // scrolling area, so they stay still while it scrolls or bounces.
    <div
      class="fc-transcript-frame"
      classList={{ "fc-chat-narrow": chatNarrow() && chapters().length > 1 }}
      ref={observeFrame}
    >
      <section
        class="fc-transcript"
        ref={container}
        onScroll={() => {
          if (!container) return
          trackChapter()
          const distance = container.scrollHeight - container.scrollTop - container.clientHeight
          setAwayFromEnd(distance > 200)
          // The reader's own input (wheel, touch, keys, scrollbar) leaves the end; content growing
          // never does, so a recent input is what unsticks, not the direction of this scroll event.
          if (distance < 120) setStick(true)
          else if (performance.now() - readerInput < 1000) setStick(false)
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
                          showRole={
                            !props.chat &&
                            (fullIndex(index()) === 0 || props.messages?.[fullIndex(index()) - 1]?.type !== "assistant")
                          }
                          toolRuns={toolRuns()}
                        />
                        <Show when={isTurnEnd(fullIndex(index()))}>
                          <TurnFooter
                            {...turnMeta(fullIndex(index()))}
                            hideAgent={props.chat}
                            commit={turnCommit(props.messages ?? [], fullIndex(index()))}
                            modelName={props.modelName}
                          />
                        </Show>
                      </Show>
                    }
                  >
                    <div class="fc-message fc-message-user" data-chapter={message.id}>
                      <div class="fc-message-role">{t("You")}</div>
                      <MessageFiles files={(message as { files?: MessageFile[] }).files} />
                      <Markdown class="fc-message-text" text={(message as { text?: string }).text ?? ""} />
                      <div class="fc-message-actions">
                        <button
                          class="fc-message-action"
                          type="button"
                          title={t("Copy")}
                          aria-label={t("Copy")}
                          onClick={() => copyText((message as { text?: string }).text ?? "")}
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                            <rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2" />
                            <path d="M5 15V6a2 2 0 0 1 2-2h9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                          </svg>
                        </button>
                        <Show when={!props.chat}>
                          <button
                            class="fc-message-action"
                            type="button"
                            title={t("Edit")}
                            aria-label={t("Edit")}
                            onClick={() => props.onEditUser(message.id, (message as { text?: string }).text ?? "")}
                          >
                            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                              <path
                                d="M4 10a8 8 0 1 1 2.3 5.7M4 20v-5h5"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                              />
                            </svg>
                          </button>
                          <Show when={props.onForkUser}>
                            <button
                              class="fc-message-action"
                              type="button"
                              title={t("Fork from here")}
                              aria-label={t("Fork from here")}
                              onClick={() => props.onForkUser?.(message.id)}
                            >
                              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                                <circle cx="7" cy="5" r="2.5" fill="none" stroke="currentColor" stroke-width="2" />
                                <circle cx="7" cy="19" r="2.5" fill="none" stroke="currentColor" stroke-width="2" />
                                <circle cx="17" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="2" />
                                <path d="M7 7.5v9M9.4 12h5.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                              </svg>
                            </button>
                          </Show>
                        </Show>
                      </div>
                    </div>
                  </Show>
                )}
              </For>
              <For each={props.pending ?? []}>
                {(item) => (
                  <div class="fc-message fc-message-user fc-message-optimistic">
                    <div class="fc-message-role">{t("You")}</div>
                    <MessageFiles files={item.files} />
                    <Markdown class="fc-message-text" text={item.text} />
                    <Show when={item.queued}>
                      <div class="fc-message-queue">
                        <span class="fc-message-queue-badge">{t("Queued")}</span>
                        <Show when={item.sendNow}>
                          <button class="fc-message-send-now" type="button" onClick={() => item.sendNow?.()}>
                            {t("Send now")}
                          </button>
                        </Show>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
              <Show when={props.busy && props.liveText}>
                <div class="fc-message fc-message-assistant fc-message-live">
                  <Markdown class="fc-message-text" text={props.liveText ?? ""} />
                </div>
              </Show>
              <Show when={props.busy}>
                <div class="fc-message fc-message-assistant fc-message-pending">
                  <Loader
                    tokens={props.usage?.tokens}
                    cost={props.usage?.cost}
                    startedAt={props.startedAt}
                    tasks={activity().tasks}
                    label={activity().label}
                  />
                </div>
              </Show>
            </Show>
          </div>
        </Show>
      </section>
      <Show when={chapters().length > 1}>
        <ChapterNav chapters={chapters()} activeId={activeChapter()} onJump={jumpToChapter} />
      </Show>
      <button
        class="fc-scroll-end"
        classList={{ "fc-scroll-end-visible": awayFromEnd() }}
        type="button"
        tabIndex={awayFromEnd() ? 0 : -1}
        aria-hidden={!awayFromEnd()}
        title={t("Scroll to the end")}
        aria-label={t("Scroll to the end")}
        onClick={scrollToEnd}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="m6 9 6 6 6-6"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>
  )
}
