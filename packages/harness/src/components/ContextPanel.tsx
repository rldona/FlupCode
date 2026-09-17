import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { formatTokens } from "../metrics"
import type { AgentInfo, McpServer, SkillInfo } from "../engine-types"
import type { ContextReport } from "../types"

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
  onRead: (path: string) => Promise<string>
  onClose: () => void
}

const bytes = (value: number) => (value < 1024 ? `${value} B` : `${Math.round(value / 102.4) / 10} kB`)

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
 * **The assembled system prompt is not here.** `/api/agent` reports a two-line description of each
 * agent, not the prompt the engine builds at turn time; that needs a plugin hook the audit already
 * names. Showing the blurb and calling it the system prompt would be worse than showing nothing,
 * so it is labelled as what it is and the gap is stated on screen.
 */
export const ContextPanel: Component<ContextPanelProps> = (props) => {
  const [openFile, setOpenFile] = createSignal<string>()
  const [content, setContent] = createSignal<string>()
  const [problem, setProblem] = createSignal<string>()

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
            Said out loud rather than quietly missing. The engine reports each agent's description,
            not the prompt it assembles at turn time.
          */}
          <section class="fc-usage-block">
            <h2>{t("The system prompt")}</h2>
            <p class="fc-usage-note">
              {t(
                "FlupCode cannot show it. The engine reports each agent's description, not the prompt it builds for a turn — that needs a plugin it does not have yet. Everything above is what goes into it.",
              )}
            </p>
            <Show when={props.agents.length > 0}>
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
