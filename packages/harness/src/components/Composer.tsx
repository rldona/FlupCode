import { For, Show, batch, createEffect, createSignal, onCleanup, onMount, type Component } from "solid-js"
import type { AgentInfo, FileSystemEntry, ModelInfo, ModelVariant } from "../engine-types"
import type { Attachment, BranchState, CommandOption, ProjectItem } from "../types"
import { t } from "../i18n"
import { toast } from "../toast"
import { ModeMenu } from "./ModeMenu"
import { DeliveryMenu } from "./DeliveryMenu"
import { FolderMenu } from "./FolderMenu"
import { EffortMenu } from "./EffortMenu"
import { ContextMeter } from "./ContextMeter"
import { PullRequestChip } from "./PullRequestChip"
import { RepoBar } from "./RepoBar"
import { AddMenu, AgentMenu, DockIcon, ModelMenu } from "./DockMenus"
import { stepHistory } from "../prompt-history"
import { dictationAvailable, startDictation } from "../dictation"
import { primaryAgents } from "../agents"
import type { AppView } from "../chat"
import type { Delivery } from "../pending-prompts"

type ComposerProps = {
  /** Chats get a plain input: no commands, mentions, folder, agent, permissions or context meter. */
  mode: AppView
  /** In split view only the focused pane's input answers window shortcuts (⌘U). */
  inactive?: boolean
  value: string
  sending: boolean
  /** The model is working on the open session: the send button becomes Stop while the input is empty. */
  generating: boolean
  onStop: () => void
  models: ModelInfo[]
  modelKey: string | undefined
  favorites: string[]
  onModelChange: (providerID: string, id: string) => void
  modelLabel: string
  variants: ModelVariant[]
  variantKey: string | undefined
  usage: { used: number; limit: number; cost?: number; tokens?: { input: number; output: number; reasoning: number } }
  repo?: {
    directory: string
    branch?: string
    additions: number
    deletions: number
    onCommit: () => void
    /** Opens the diff viewer on this folder. */
    onOpenChanges?: () => void
    onClear?: () => void
  }
  /** Where the branch stands on GitHub, drawn above the repo bar. Absent when `gh` cannot say. */
  pullRequest?: {
    state: BranchState | undefined
    creating: boolean
    suggestedTitle: string
    onOpenPullRequest: (title: string) => void
    onOpen: (url: string) => void
  }
  attachments: Attachment[]
  commands: CommandOption[]
  projects: ProjectItem[]
  /** The folder of the open session, or the one picked for a new session. The picker only shows without one. */
  targetDirectory: string | undefined
  agents: AgentInfo[]
  agent: string
  permissionMode: string
  /** What the engine should do with a prompt sent while the turn is running; only shown then. */
  delivery: Delivery
  onDeliveryChange: (value: Delivery) => void
  /** Suggested next message, shown greyed while the input is empty; Tab accepts it. */
  suggestion?: string
  /** Prompts sent before, oldest first; ↑ and ↓ walk through them. */
  history: string[]
  onInput: (value: string) => void
  onSend: () => void
  onOpenModelPicker: () => void
  onVariantChange: (value: string) => void
  onAttach: (files: File[]) => void
  onRemoveAttachment: (uri: string) => void
  onCommandPick: (name: string) => void
  /** Runs the command highlighted in the slash menu when the reader presses Enter. */
  onCommandRun: (name: string) => void
  searchFiles: (query: string) => Promise<FileSystemEntry[]>
  onPasteText: (text: string) => string
  onStash: () => void
  onTargetChange: (directory: string | undefined) => void
  onOpenFolder: () => void
  onAgentChange: (agent: string) => void
  onPermissionModeChange: (id: string) => void
}

export const Composer: Component<ComposerProps> = (props) => {
  let fileInput: HTMLInputElement | undefined
  let input: HTMLTextAreaElement | undefined
  let stopDictation: (() => void) | undefined
  const [listening, setListening] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)
  const [fileResults, setFileResults] = createSignal<FileSystemEntry[]>([])
  // Browsing sent prompts: the one shown, and the draft to return to past the newest.
  const [historyIndex, setHistoryIndex] = createSignal<number>()
  // The command highlighted in the slash menu (arrows move it, Enter runs it).
  const [commandIndex, setCommandIndex] = createSignal(0)
  let historyDraft = ""

  // Editing or sending the recalled prompt leaves the history.
  createEffect(() => {
    const index = historyIndex()
    if (index !== undefined && props.value !== props.history[index]) setHistoryIndex(undefined)
  })

  const browseHistory = (direction: "up" | "down") => {
    const current = historyIndex()
    const next = stepHistory(props.history.length, current, direction)
    if (next === current) return false
    if (current === undefined) historyDraft = props.value
    batch(() => {
      setHistoryIndex(next)
      props.onInput(next === undefined ? historyDraft : props.history[next]!)
    })
    // The batch has already written the value, so the caret moves before the next key can land.
    if (input) {
      const at = direction === "up" ? 0 : input.value.length
      input.setSelectionRange(at, at)
    }
    return true
  }

  onCleanup(() => stopDictation?.())

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (props.inactive) return
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "u") {
        event.preventDefault()
        fileInput?.click()
      }
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  // The input grows with its text up to a limit, like Claude Code's. A suggestion lives in the
  // placeholder, which `scrollHeight` ignores, so measure it through the field before restoring.
  createEffect(() => {
    const value = props.value
    const suggestion = props.suggestion
    if (!input) return
    input.style.height = "auto"
    if (!value && suggestion) {
      input.value = suggestion
      input.style.height = `${Math.min(input.scrollHeight, 240)}px`
      input.value = value
      return
    }
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`
  })

  // While the model works, Stop takes the send button's place (Enter still sends); it returns when the run ends.
  const showStop = () => props.generating

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    props.onAttach(Array.from(files))
  }

  const chat = () => props.mode === "chat"

  const commandQuery = () => {
    const value = props.value
    if (chat() || !value.startsWith("/")) return
    const body = value.slice(1)
    if (body.includes(" ")) return
    return body.toLowerCase()
  }

  const filteredCommands = () => {
    const query = commandQuery()
    if (query === undefined) return []
    return props.commands.filter((command) => command.name.toLowerCase().includes(query)).slice(0, 8)
  }

  // The highlighted command is the first match of every new query.
  createEffect(() => {
    filteredCommands()
    setCommandIndex(0)
  })

  const moveCommand = (delta: number) => {
    const count = filteredCommands().length
    if (count === 0) return
    setCommandIndex((index) => (index + delta + count) % count)
  }

  const mentionToken = () => {
    const value = props.value
    if (chat()) return
    const at = value.lastIndexOf("@")
    if (at === -1) return
    const token = value.slice(at + 1)
    if (token.includes(" ")) return
    return token
  }

  createEffect(() => {
    const token = mentionToken()
    if (token === undefined || commandQuery() !== undefined) {
      setFileResults([])
      return
    }
    const handle = setTimeout(async () => {
      try {
        setFileResults(await props.searchFiles(token))
      } catch {
        setFileResults([])
      }
    }, 150)
    onCleanup(() => clearTimeout(handle))
  })

  // Escape or a click outside closes the / and @ menus. Closing the command menu drops the unfinished
  // "/command" (it is all the input holds then); the @ menu keeps the text and stays closed only until
  // the text changes, so deleting and typing again opens it.
  const [dismissedAt, setDismissedAt] = createSignal<string>()
  createEffect(() => {
    const dismissed = dismissedAt()
    if (dismissed !== undefined && props.value !== dismissed) setDismissedAt(undefined)
  })
  const menusDismissed = () => dismissedAt() !== undefined && dismissedAt() === props.value
  const commandMenuOpen = () => !menusDismissed() && commandQuery() !== undefined && filteredCommands().length > 0
  const mentionMenuOpen = () =>
    !menusDismissed() && commandQuery() === undefined && mentionToken() !== undefined && fileResults().length > 0
  const closeMenus = () => {
    if (commandMenuOpen()) props.onInput("")
    else setDismissedAt(props.value)
  }
  let menu: HTMLDivElement | undefined
  let inputWrap: HTMLDivElement | undefined
  onMount(() => {
    const onPointer = (event: MouseEvent) => {
      if (!commandMenuOpen() && !mentionMenuOpen()) return
      const target = event.target as Node
      if (menu?.contains(target) || inputWrap?.contains(target)) return
      closeMenus()
    }
    document.addEventListener("mousedown", onPointer)
    onCleanup(() => document.removeEventListener("mousedown", onPointer))
  })

  // Keep the highlighted command in view while the arrows walk the menu.
  createEffect(() => {
    const index = commandIndex()
    if (!commandMenuOpen()) return
    menu?.querySelectorAll<HTMLElement>(".fc-command-item")[index]?.scrollIntoView({ block: "nearest" })
  })

  const insertMention = (path: string) => {
    const value = props.value
    const at = value.lastIndexOf("@")
    if (at === -1) return
    props.onInput(`${value.slice(0, at)}@${path} `)
    setFileResults([])
  }

  const toggleVoice = () => {
    if (listening()) {
      stopDictation?.()
      stopDictation = undefined
      return
    }
    const base = props.value
    const stop = startDictation({
      lang: navigator.language,
      onTranscript: (text) => props.onInput(`${base} ${text}`.trim()),
      onError: (code) =>
        toast(code ? `${t("Voice dictation failed")} (${code})` : t("Voice dictation failed"), "error"),
      onEnd: () => {
        stopDictation = undefined
        setListening(false)
      },
    })
    if (!stop) return
    stopDictation = stop
    setListening(true)
  }

  return (
    <footer
      class="fc-composer"
      classList={{ "fc-composer-dragging": dragging() }}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        handleFiles(event.dataTransfer?.files ?? null)
      }}
    >
      <div class="fc-composer-inner">
        <Show when={props.pullRequest}>{(pr) => <PullRequestChip {...pr()} />}</Show>
        <Show when={props.repo}>{(repo) => <RepoBar {...repo()} />}</Show>

        <Show when={commandMenuOpen()}>
          <div class="fc-command-menu" ref={menu}>
            <For each={filteredCommands()}>
              {(command, index) => (
                <button
                  class="fc-command-item"
                  classList={{ "fc-command-item-active": commandIndex() === index() && !command.disabled }}
                  type="button"
                  disabled={command.disabled}
                  onMouseEnter={() => setCommandIndex(index())}
                  onClick={() => props.onCommandPick(command.name)}
                >
                  <span class="fc-command-name">/{command.name}</span>
                  <Show when={command.description}>
                    <span class="fc-command-desc">{command.description}</span>
                  </Show>
                  <Show when={command.disabled}>
                    <span class="fc-command-soon">{t("Soon")}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={mentionMenuOpen()}>
          <div class="fc-command-menu" ref={menu}>
            <For each={fileResults()}>
              {(file) => (
                <button class="fc-command-item" type="button" onClick={() => insertMention(file.path)}>
                  <span class="fc-command-name">@{file.path}</span>
                  <span class="fc-command-desc">{file.type}</span>
                </button>
              )}
            </For>
          </div>
        </Show>

        <div
          class="fc-input-wrap"
          classList={{ "fc-input-wrap-history": historyIndex() !== undefined }}
          ref={inputWrap}
        >
          <Show when={historyIndex() !== undefined}>
            <div class="fc-input-history" aria-live="polite">
              {t("History {n}/{total}", { n: historyIndex()! + 1, total: props.history.length })}
            </div>
          </Show>
          <Show when={props.attachments.length > 0}>
            <div class="fc-dock-attachments">
              <For each={props.attachments}>
                {(attachment) => (
                  <div class="fc-dock-attachment" title={attachment.name}>
                    <Show
                      when={attachment.uri.startsWith("data:image/")}
                      fallback={
                        <span class="fc-dock-attachment-file">
                          <DockIcon
                            path="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Zm0 0v5h5"
                            size={22}
                          />
                          <span class="fc-dock-attachment-name">{attachment.name}</span>
                        </span>
                      }
                    >
                      <img class="fc-dock-attachment-image" src={attachment.uri} alt={attachment.name} />
                    </Show>
                    <button
                      class="fc-dock-attachment-remove"
                      type="button"
                      aria-label={`${t("Remove")} ${attachment.name}`}
                      onClick={() => props.onRemoveAttachment(attachment.uri)}
                    >
                      <DockIcon path="M7 7l10 10M17 7 7 17" size={12} />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <textarea
            ref={input}
            class="fc-input"
            classList={{ "fc-input-suggesting": !!props.suggestion && !props.value }}
            rows={1}
            placeholder={props.suggestion ?? (chat() ? t("Write a message…") : t("Type / for commands"))}
            value={props.value}
            onInput={(event) => props.onInput(event.currentTarget.value)}
            onPaste={(event) => {
              const files = event.clipboardData?.files
              if (files && files.length > 0) {
                event.preventDefault()
                handleFiles(files)
                return
              }
              const raw = event.clipboardData?.getData("text")
              if (raw && (raw.length > 2000 || raw.split("\n").length > 20)) {
                event.preventDefault()
                const token = props.onPasteText(raw)
                props.onInput(`${props.value}${props.value ? " " : ""}${token}`)
              }
            }}
            onKeyDown={(event) => {
              if (
                (event.key === "Tab" || event.key === "ArrowRight") &&
                !event.shiftKey &&
                !event.isComposing &&
                props.suggestion &&
                !props.value
              ) {
                event.preventDefault()
                props.onInput(props.suggestion)
                return
              }
              const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && !event.isComposing
              // With the slash menu open the arrows walk it (not the prompt history) and Enter runs
              // the highlighted command instead of sending the half-typed text.
              if (commandMenuOpen()) {
                if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !event.isComposing) {
                  event.preventDefault()
                  moveCommand(event.key === "ArrowDown" ? 1 : -1)
                  return
                }
                if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                  const command = filteredCommands()[commandIndex()]
                  if (command && !command.disabled) {
                    event.preventDefault()
                    props.onCommandRun(command.name)
                    return
                  }
                }
              }
              if (plain && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                const target = event.currentTarget
                const collapsed = target.selectionStart === target.selectionEnd
                const browsing = historyIndex() !== undefined
                // Like a shell: ↑ recalls from the first line, and while browsing both arrows keep walking.
                const onFirstLine = collapsed && !target.value.slice(0, target.selectionStart).includes("\n")
                if (event.key === "ArrowUp" ? browsing || onFirstLine : browsing) {
                  if (browseHistory(event.key === "ArrowUp" ? "up" : "down")) event.preventDefault()
                  return
                }
              }
              if (event.key === "Escape" && (commandMenuOpen() || mentionMenuOpen())) {
                event.preventDefault()
                closeMenus()
                return
              }
              if (event.key === "Escape" && historyIndex() !== undefined) {
                event.preventDefault()
                batch(() => {
                  setHistoryIndex(undefined)
                  props.onInput(historyDraft)
                })
                return
              }
              if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault()
                props.onSend()
              }
            }}
          />
          <Show when={props.suggestion && !props.value}>
            <kbd class="fc-input-tab-hint" aria-hidden="true">
              Tab · →
            </kbd>
          </Show>
          <Show
            when={showStop()}
            fallback={
              <button
                class="fc-input-send"
                type="button"
                title={t("Send")}
                aria-label={t("Send")}
                onClick={props.onSend}
                disabled={props.sending || (props.value.trim().length === 0 && props.attachments.length === 0)}
              >
                <DockIcon path="M12 19V5M6 11l6-6 6 6" size={18} />
              </button>
            }
          >
            <button
              class="fc-input-send fc-input-stop"
              type="button"
              title={t("Stop")}
              aria-label={t("Stop")}
              onClick={props.onStop}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8" />
                <rect x="9" y="9" width="6" height="6" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          </Show>
        </div>

        <div class="fc-composer-bottom">
          <div class="fc-composer-left">
            <AddMenu
              canAddFolder={!chat() && !props.targetDirectory}
              onAddFiles={() => fileInput?.click()}
              onAddFolder={props.onOpenFolder}
              onSlashCommands={
                chat()
                  ? undefined
                  : () => {
                      if (!props.value.startsWith("/")) props.onInput("/")
                      input?.focus()
                    }
              }
            />
            <button
              class="fc-dock-icon"
              classList={{ "fc-dock-listening": listening() }}
              type="button"
              title={t("Voice dictation")}
              aria-label={t("Voice dictation")}
              aria-pressed={listening()}
              disabled={!dictationAvailable()}
              onClick={toggleVoice}
            >
              <DockIcon path="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3" />
            </button>
            <Show when={!chat() && !props.targetDirectory}>
              <FolderMenu
                value={props.targetDirectory}
                projects={props.projects}
                onSelect={props.onTargetChange}
                onOpenFolder={props.onOpenFolder}
              />
            </Show>
            <Show when={!chat() && props.value.startsWith("!")}>
              <span class="fc-chip fc-chip-active">{t("Shell")}</span>
            </Show>
            <Show when={!chat()}>
              <Show when={primaryAgents(props.agents).length > 1}>
                <AgentMenu agents={primaryAgents(props.agents)} value={props.agent} onChange={props.onAgentChange} />
              </Show>
              <ModeMenu value={props.permissionMode} onChange={props.onPermissionModeChange} />
              {/* Always here, not only mid-turn: it is a standing preference, and a control that
                  appears only once the agent is already working is a control nobody finds. */}
              <DeliveryMenu value={props.delivery} onChange={props.onDeliveryChange} />
            </Show>
          </div>

          <div class="fc-composer-right">
            <ModelMenu
              label={props.modelLabel}
              models={props.models}
              selectedKey={props.modelKey}
              favorites={props.favorites}
              disabled={props.generating}
              onSelect={props.onModelChange}
              onMore={props.onOpenModelPicker}
            />
            {/* Models without effort levels (here) show no menu, rather than a disabled one. */}
            <Show when={props.variants.length > 0}>
              <EffortMenu
                value={props.variantKey}
                variants={props.variants}
                disabled={props.generating}
                onChange={props.onVariantChange}
              />
            </Show>
            <Show when={!chat()}>
              <ContextMeter
                used={props.usage.used}
                limit={props.usage.limit}
                cost={props.usage.cost}
                tokens={props.usage.tokens}
              />
            </Show>
          </div>
        </div>
      </div>

      <input
        ref={fileInput}
        class="fc-file-input"
        type="file"
        multiple
        onChange={(event) => {
          handleFiles(event.currentTarget.files)
          event.currentTarget.value = ""
        }}
      />
    </footer>
  )
}
