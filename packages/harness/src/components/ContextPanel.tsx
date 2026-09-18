import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { formatTokens } from "../metrics"
import type { AgentInfo, McpServer, SkillInfo } from "../engine-types"
import { mcpLatency, mcpToolUses } from "../mcp"
import type { CapturedPrompt, ContextReport, ToolCall } from "../types"
import { duration } from "./UsagePanel"

export type ContextTokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

type ContextPanelProps = {
  open: boolean
  directory?: string
  report: ContextReport | undefined
  loading: boolean
  serverAvailable: boolean
  skills: SkillInfo[]
  agents: AgentInfo[]
  /** The agent this session runs as, so the list can say which one is in play. */
  agent?: string
  tools: string[]
  mcp: McpServer[]
  tokens?: ContextTokens
  /** How many times this session has been compacted, from its transcript. */
  compactions: number
  /** The system prompts the engine assembled for this session's last requests, newest first. */
  prompts?: CapturedPrompt[]
  promptsLoading: boolean
  /** The tools this session ran, by name, as FlupCode's engine plugin recorded them. */
  toolUses?: Record<string, { count: number; last: number }>
  /** The completed calls, timed, so an MCP server's latency can be shown (H-16). */
  toolCalls?: ToolCall[]
  onRead: (path: string) => Promise<string>
  onClose: () => void
}

const bytes = (value: number) => (value < 1024 ? `${value} B` : `${Math.round(value / 102.4) / 10} kB`)

const when = (at: number) => new Date(at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })

const name = (path: string) => {
  const parts = path.split("/").filter(Boolean)
  return parts.slice(-2).join("/")
}

/** Roughly how many tokens a file of this size costs. Called an estimate, because it is one. */
export const roughTokens = (value: number) => Math.round(value / 4)

/**
 * What the model was given (H-17).
 *
 * The audit calls the context opaque. This makes the part of it that can be known exactly — which
 * instruction files load and in what order, which skills and tools are on offer, what the window
 * actually holds — visible, and is explicit about the part that cannot.
 *
 * The assembled system prompt is the one part no endpoint reports, because the engine builds it at
 * request time and hands it straight to the provider. FlupCode's engine plugin reads it off the
 * request as it goes out and records it, so this shows those recordings rather than a description of
 * them: a session has several (the turn, its title, a compaction), so they are listed newest first.
 */
export const ContextPanel: Component<ContextPanelProps> = (props) => {
  const [openFile, setOpenFile] = createSignal<string>()
  const [content, setContent] = createSignal<string>()
  const [problem, setProblem] = createSignal<string>()
  const [openPrompt, setOpenPrompt] = createSignal<number>()

  const read = (path: string) => {
    if (openFile() === path) {
      setOpenFile(undefined)
      return
    }
    setOpenFile(path)
    setContent(undefined)
    setProblem(undefined)
    props
      .onRead(path)
      .then(setContent)
      .catch((cause) => setProblem(cause instanceof Error ? cause.message : String(cause)))
  }

  const instructionBytes = createMemo(() =>
    (props.report?.instructions ?? []).reduce((sum, file) => sum + file.bytes, 0),
  )
  const window = createMemo(() => {
    const tokens = props.tokens
    if (!tokens) return []
    return [
      { key: t("Sent"), value: tokens.input },
      { key: t("Answered"), value: tokens.output },
      { key: t("Reasoning"), value: tokens.reasoning },
      { key: t("Read from cache"), value: tokens.cacheRead },
      { key: t("Written to cache"), value: tokens.cacheWrite },
    ].filter((entry) => entry.value > 0)
  })
  const connected = createMemo(() =>
    props.mcp.filter((server) => (server.status as { status?: string } | undefined)?.status === "connected"),
  )
  const mcpUses = createMemo(() => mcpToolUses(props.mcp, props.toolUses ?? {}))
  const mcpTimes = createMemo(() => mcpLatency(props.mcp, props.toolCalls ?? []))

  return (
    <Show when={props.open}>
      <section class="fc-routines-screen" aria-label={t("Context")}>
        <div class="fc-routines-header">
          <div>
            <div class="fc-routines-kicker">{t("Automation")}</div>
            <h1>{t("Context")}</h1>
            <p>{t("What a turn in this folder is given before your prompt.")}</p>
          </div>
          <div class="fc-routines-header-actions">
            <button class="fc-button" type="button" onClick={props.onClose}>
              {t("Back to sessions")}
            </button>
          </div>
        </div>

        <Show when={!props.serverAvailable}>
          <div class="fc-routines-notice">{t("The harness server is not reachable, so this is the last it said.")}</div>
        </Show>

        <div class="fc-context-screen">
          <section class="fc-usage-block">
            <h2>
              {t("Instructions")}
              <Show when={instructionBytes() > 0}>
                <span class="fc-context-aside">
                  {t("{size}, about {tokens} tokens", {
                    size: bytes(instructionBytes()),
                    tokens: formatTokens(roughTokens(instructionBytes())),
                  })}
                </span>
              </Show>
            </h2>
            <p class="fc-usage-note">
              {t("Every AGENTS.md from your config folder down to this one. The nearest has the last word.")}
            </p>
            <Show when={props.report?.problem}>
              {(why) => <div class="fc-routines-notice">{why()}</div>}
            </Show>
            <Show
              when={(props.report?.instructions.length ?? 0) > 0}
              fallback={
                <p class="fc-usage-note">
                  {props.loading ? t("Reading…") : t("Nothing is loaded. A turn here starts with your prompt alone.")}
                </p>
              }
            >
              <For each={props.report?.instructions ?? []}>
                {(file) => (
                  <div class="fc-context-file">
                    <button class="fc-usage-row fc-context-row" type="button" onClick={() => read(file.path)}>
                      <span class="fc-diff-status">{t(file.scope)}</span>
                      <span class="fc-usage-key" title={file.path}>
                        {name(file.path)}
                      </span>
                      <span class="fc-context-excerpt">{file.excerpt}</span>
                      <span class="fc-usage-cost">{bytes(file.bytes)}</span>
                    </button>
                    <Show when={openFile() === file.path}>
                      <Show when={problem()} fallback={<pre class="fc-pr-log">{content() ?? t("Reading…")}</pre>}>
                        {(message) => <p class="fc-usage-note">{message()}</p>}
                      </Show>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </section>

          <section class="fc-usage-block">
            <h2>
              {t("Skills")}
              <span class="fc-context-aside">{props.skills.length}</span>
            </h2>
            <p class="fc-usage-note">{t("Offered to the model by name and description; the body loads only when one is used.")}</p>
            <Show when={props.skills.length > 0} fallback={<p class="fc-usage-note">{t("None")}</p>}>
              <For each={props.skills}>
                {(skill) => (
                  <div class="fc-usage-row">
                    <span class="fc-usage-key">{skill.name}</span>
                    <span class="fc-context-excerpt">{skill.description}</span>
                  </div>
                )}
              </For>
            </Show>
          </section>

          <section class="fc-usage-block">
            <h2>
              {t("Tools")}
              <span class="fc-context-aside">{props.tools.length}</span>
            </h2>
            <Show when={props.tools.length > 0} fallback={<p class="fc-usage-note">{t("None")}</p>}>
              <div class="fc-context-chips">
                <For each={props.tools}>{(tool) => <span class="fc-context-chip">{tool}</span>}</For>
              </div>
            </Show>
            <Show when={props.mcp.length > 0}>
              <p class="fc-usage-note">
                {t("{connected} of {total} MCP servers connected", {
                  connected: connected().length,
                  total: props.mcp.length,
                })}
              </p>
              <div class="fc-context-chips">
                <For each={props.mcp}>
                  {(server) => (
                    <span
                      class="fc-context-chip"
                      classList={{ "fc-context-chip-off": !connected().includes(server) }}
                    >
                      {server.name}
                    </span>
                  )}
                </For>
              </div>
              {/* A server's own tools are unreachable: they bypass the tool registry, so no endpoint
                  lists them and the prompt carries only the server's name. What a session ran does
                  come through, and it answers the question a reader actually has. */}
              <p class="fc-usage-note">
                {t(
                  "The engine lists no tools for a server, only the calls that go through one. These are the tools this session used:",
                )}
              </p>
              <Show
                when={mcpUses().length > 0}
                fallback={<p class="fc-usage-note">{t("None used in this session.")}</p>}
              >
                <For each={mcpUses()}>
                  {(entry) => (
                    <div class="fc-usage-row fc-mcp-use">
                      <span class="fc-usage-key">{entry.server}</span>
                      <span class="fc-context-excerpt">
                        {entry.tools
                          .map((tool) => `${tool.name}${tool.count > 1 ? ` ×${tool.count}` : ""}`)
                          .join(", ")}
                      </span>
                    </div>
                  )}
                </For>
              </Show>
              {/*
                How long those calls took (H-16). The engine reports no timing of its own; the calls
                the plugin timed are what a reader can go on when a server feels slow.
              */}
              <Show when={mcpTimes().length > 0}>
                <p class="fc-usage-note">{t("How long this session's calls into them took:")}</p>
                <For each={mcpTimes()}>
                  {(entry) => (
                    <div class="fc-usage-row fc-mcp-use">
                      <span class="fc-usage-key">{entry.server}</span>
                      <span class="fc-context-excerpt">
                        {t("{calls} calls · {average} average · slowest {slowest}", {
                          calls: entry.calls,
                          average: duration(entry.averageMs),
                          slowest: duration(entry.slowestMs),
                        })}
                      </span>
                    </div>
                  )}
                </For>
              </Show>
            </Show>
          </section>

          <Show when={window().length > 0}>
            <section class="fc-usage-block">
              <h2>{t("This session's tokens")}</h2>
              <For each={window()}>
                {(entry) => (
                  <div class="fc-usage-row">
                    <span class="fc-usage-key">{entry.key}</span>
                    <span class="fc-usage-cost">{formatTokens(entry.value)}</span>
                  </div>
                )}
              </For>
              <Show when={props.compactions > 0}>
                <p class="fc-usage-note">
                  {t("Compacted {n} times: everything before each is a summary now.", { n: props.compactions })}
                </p>
              </Show>
            </section>
          </Show>

          {/*
            What the engine actually sent. Said in place of the note that used to stand here: the
            prompt is no longer the part of the context this screen cannot show.
          */}
          <section class="fc-usage-block">
            <h2>
              {t("The system prompt")}
              <Show when={(props.prompts?.length ?? 0) > 0}>
                <span class="fc-context-aside">{props.prompts!.length}</span>
              </Show>
            </h2>
            <p class="fc-usage-note">
              {t(
                "Recorded as each request went out, so it is what the model was given and not a description of it. The longest is the turn; titles and compactions are recorded too.",
              )}
            </p>
            <Show
              when={(props.prompts?.length ?? 0) > 0}
              fallback={
                <p class="fc-usage-note">
                  {props.promptsLoading
                    ? t("Reading…")
                    : t(
                        "Nothing recorded yet. FlupCode's engine plugin captures it from the next turn, and an engine that was already running needs a restart to load it.",
                      )}
                </p>
              }
            >
              <For each={props.prompts}>
                {(prompt) => (
                  <div class="fc-context-file">
                    <button
                      class="fc-usage-row fc-context-row"
                      type="button"
                      onClick={() => setOpenPrompt((value) => (value === prompt.at ? undefined : prompt.at))}
                    >
                      <span class="fc-usage-key">{when(prompt.at)}</span>
                      <span class="fc-context-excerpt">
                        {[prompt.providerID, prompt.modelID].filter(Boolean).join("/")}
                      </span>
                      <span class="fc-usage-cost">{bytes(prompt.system.join("\n\n").length)}</span>
                    </button>
                    <Show when={openPrompt() === prompt.at}>
                      <pre class="fc-pr-log">{prompt.system.join("\n\n")}</pre>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
            <Show when={props.agents.length > 0}>
              <p class="fc-usage-note">{t("Agents, whose own prompt is part of what is above:")}</p>
              <For each={props.agents.filter((agent) => !agent.hidden)}>
                {(agent) => (
                  <div class="fc-usage-row">
                    <span class="fc-usage-key">
                      {agent.id}
                      <Show when={agent.id === props.agent}>
                        <span class="fc-context-aside">{t("this session")}</span>
                      </Show>
                    </span>
                    <span class="fc-context-excerpt">{agent.description}</span>
                  </div>
                )}
              </For>
            </Show>
          </section>
        </div>
      </section>
    </Show>
  )
}
