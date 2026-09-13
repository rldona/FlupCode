import { For, Show, createEffect, createSignal, onCleanup, onMount, type Component } from "solid-js"
import type { AgentInfo, FileSystemEntry, ModelInfo, ModelVariant } from "../engine-types"
import type { Attachment, CommandOption, ProjectItem } from "../types"
import { t } from "../i18n"
import { ModeMenu } from "./ModeMenu"
import { FolderMenu } from "./FolderMenu"
import { EffortMenu } from "./EffortMenu"
import { ContextMeter } from "./ContextMeter"
import { RepoBar } from "./RepoBar"
import { AddMenu, AgentMenu, DockIcon, ModelMenu } from "./DockMenus"

type ComposerProps = {
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
    onClear?: () => void
  }
  attachments: Attachment[]
  commands: CommandOption[]
  projects: ProjectItem[]
  /** The folder of the open session, or the one picked for a new session. The picker only shows without one. */
  targetDirectory: string | undefined
  agents: AgentInfo[]
  agent: string
  permissionMode: string
  onInput: (value: string) => void
  onSend: () => void
  onOpenModelPicker: () => void
  onVariantChange: (value: string) => void
  onAttach: (files: File[]) => void
  onRemoveAttachment: (uri: string) => void
  onCommandPick: (name: string) => void
  searchFiles: (query: string) => Promise<FileSystemEntry[]>
  onPasteText: (text: string) => string
  onStash: () => void
  onTargetChange: (directory: string | undefined) => void
  onOpenFolder: () => void
  onAgentChange: (agent: string) => void
  onPermissionModeChange: (id: string) => void
}

function primaryAgents(agents: AgentInfo[]) {
  return agents.filter((agent) => agent.mode === "primary" && !agent.hidden)
}

type SpeechRecognitionResult = {
  0: { transcript: string }
  isFinal: boolean
}

type SpeechRecognitionEventLike = {
  results: ArrayLike<SpeechRecognitionResult>
}

export type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

export function speechRecognition(): SpeechRecognitionConstructor | undefined {
  if (typeof window === "undefined") return
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition
}

export const Composer: Component<ComposerProps> = (props) => {
  let fileInput: HTMLInputElement | undefined
  let input: HTMLTextAreaElement | undefined
  let recognition: SpeechRecognitionLike | undefined
  const [listening, setListening] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)
  const [fileResults, setFileResults] = createSignal<FileSystemEntry[]>([])

  onCleanup(() => recognition?.stop())

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "u") {
        event.preventDefault()
        fileInput?.click()
      }
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  // The input grows with its text up to a limit, like Claude Code's.
  createEffect(() => {
    props.value
    if (!input) return
    input.style.height = "auto"
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`
  })

  // While the model works, Stop takes the send button's place (Enter still sends); it returns when the run ends.
  const showStop = () => props.generating

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    props.onAttach(Array.from(files))
  }

  const commandQuery = () => {
    const value = props.value
    if (!value.startsWith("/")) return
    const body = value.slice(1)
    if (body.includes(" ")) return
    return body.toLowerCase()
  }

  const filteredCommands = () => {
    const query = commandQuery()
    if (query === undefined) return []
    return props.commands.filter((command) => command.name.toLowerCase().includes(query)).slice(0, 8)
  }

  const mentionToken = () => {
    const value = props.value
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

  const insertMention = (path: string) => {
    const value = props.value
    const at = value.lastIndexOf("@")
    if (at === -1) return
    props.onInput(`${value.slice(0, at)}@${path} `)
    setFileResults([])
  }

  const toggleVoice = () => {
    if (listening()) {
      recognition?.stop()
      return
    }
    const Ctor = speechRecognition()
    if (!Ctor) return
    recognition = new Ctor()
    recognition.lang = navigator.language || "en-US"
    recognition.continuous = true
    recognition.interimResults = false
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .filter((result) => result.isFinal)
        .map((result) => result[0].transcript)
        .join(" ")
      if (transcript.trim()) props.onInput(`${props.value} ${transcript}`.trim())
    }
    recognition.onend = () => setListening(false)
    recognition.onerror = () => setListening(false)
    recognition.start()
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
        <Show when={props.repo}>{(repo) => <RepoBar {...repo()} />}</Show>

        <Show when={commandQuery() !== undefined && filteredCommands().length > 0}>
          <div class="fc-command-menu">
            <For each={filteredCommands()}>
              {(command) => (
                <button class="fc-command-item" type="button" onClick={() => props.onCommandPick(command.name)}>
                  <span class="fc-command-name">/{command.name}</span>
                  <Show when={command.description}>
                    <span class="fc-command-desc">{command.description}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={commandQuery() === undefined && mentionToken() !== undefined && fileResults().length > 0}>
          <div class="fc-command-menu">
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

        <div class="fc-input-wrap">
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
            rows={1}
            placeholder={t("Type / for commands")}
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
              if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault()
                props.onSend()
              }
            }}
          />
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
              canAddFolder={!props.targetDirectory}
              onAddFiles={() => fileInput?.click()}
              onAddFolder={props.onOpenFolder}
              onSlashCommands={() => {
                if (!props.value.startsWith("/")) props.onInput("/")
                input?.focus()
              }}
            />
            <button
              class="fc-dock-icon"
              classList={{ "fc-dock-listening": listening() }}
              type="button"
              title={t("Voice dictation")}
              aria-label={t("Voice dictation")}
              aria-pressed={listening()}
              disabled={!speechRecognition()}
              onClick={toggleVoice}
            >
              <DockIcon path="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3" />
            </button>
            <Show when={!props.targetDirectory}>
              <FolderMenu
                value={props.targetDirectory}
                projects={props.projects}
                onSelect={props.onTargetChange}
                onOpenFolder={props.onOpenFolder}
              />
            </Show>
            <Show when={props.value.startsWith("!")}>
              <span class="fc-chip fc-chip-active">{t("Shell")}</span>
            </Show>
            <Show when={primaryAgents(props.agents).length > 1}>
              <AgentMenu agents={primaryAgents(props.agents)} value={props.agent} onChange={props.onAgentChange} />
            </Show>
            <ModeMenu value={props.permissionMode} onChange={props.onPermissionModeChange} />
          </div>

          <div class="fc-composer-right">
            <ModelMenu
              label={props.modelLabel}
              models={props.models}
              selectedKey={props.modelKey}
              favorites={props.favorites}
              onSelect={props.onModelChange}
              onMore={props.onOpenModelPicker}
            />
            <EffortMenu
              value={props.variantKey}
              variants={props.variants}
              disabled={props.variants.length === 0}
              onChange={props.onVariantChange}
            />
            <ContextMeter
              used={props.usage.used}
              limit={props.usage.limit}
              cost={props.usage.cost}
              tokens={props.usage.tokens}
            />
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
