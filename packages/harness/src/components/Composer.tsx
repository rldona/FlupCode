import { For, Show, createEffect, createSignal, onCleanup, type Component } from "solid-js"
import type { AgentInfo, FileSystemEntry, ModelVariant } from "../engine-types"
import type { Attachment, CommandOption, ProjectItem } from "../types"
import { t } from "../i18n"
import { ModeMenu } from "./ModeMenu"

type ComposerProps = {
  value: string
  sending: boolean
  modelLabel: string
  variants: ModelVariant[]
  variantKey: string | undefined
  attachments: Attachment[]
  commands: CommandOption[]
  projects: ProjectItem[]
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

function projectLabel(project: ProjectItem) {
  return project.name || project.directory.split("/").filter(Boolean).at(-1) || project.directory
}

type SpeechRecognitionResult = {
  0: { transcript: string }
  isFinal: boolean
}

type SpeechRecognitionEventLike = {
  results: ArrayLike<SpeechRecognitionResult>
}

type SpeechRecognitionLike = {
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

function speechRecognition(): SpeechRecognitionConstructor | undefined {
  if (typeof window === "undefined") return
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition
}

export const Composer: Component<ComposerProps> = (props) => {
  let fileInput: HTMLInputElement | undefined
  let recognition: SpeechRecognitionLike | undefined
  const [listening, setListening] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)
  const [fileResults, setFileResults] = createSignal<FileSystemEntry[]>([])

  onCleanup(() => recognition?.stop())

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
      <div class="fc-composer-chips">
        <select
          class="fc-folder-select"
          aria-label={t("Folder")}
          value={props.targetDirectory ?? ""}
          onChange={(event) => {
            const value = event.currentTarget.value
            if (value === "__open__") {
              event.currentTarget.value = props.targetDirectory ?? ""
              props.onOpenFolder()
              return
            }
            props.onTargetChange(value || undefined)
          }}
        >
          <option value="">{t("No folder")}</option>
          <For each={props.projects}>
            {(project) => <option value={project.directory}>{projectLabel(project)}</option>}
          </For>
          <Show when={props.targetDirectory && !props.projects.some((p) => p.directory === props.targetDirectory)}>
            <option value={props.targetDirectory}>
              {props.targetDirectory?.split("/").filter(Boolean).at(-1) ?? props.targetDirectory}
            </option>
          </Show>
          <option value="__open__">{t("Open folder…")}</option>
        </select>
        <Show when={props.value.startsWith("!")}>
          <span class="fc-chip fc-chip-active">{t("Shell")}</span>
        </Show>
      </div>

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

      <Show when={props.attachments.length > 0}>
        <div class="fc-attachments">
          <For each={props.attachments}>
            {(attachment) => (
              <span class="fc-attachment">
                <span class="fc-attachment-name">{attachment.name}</span>
                <button
                  class="fc-attachment-remove"
                  type="button"
                  aria-label={`${t("Remove")} ${attachment.name}`}
                  onClick={() => props.onRemoveAttachment(attachment.uri)}
                >
                  ×
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>

      <div class="fc-input-wrap">
        <textarea
          class="fc-input"
          rows={1}
          placeholder={t("Describe a task or ask a question")}
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
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              props.onSend()
            }
          }}
        />
      </div>

      <div class="fc-composer-bottom">
        <div class="fc-composer-left">
          <button
            class="fc-icon-button"
            type="button"
            title={t("Attach")}
            aria-label={t("Attach")}
            onClick={() => fileInput?.click()}
          >
            +
          </button>
          <button
            class="fc-icon-button"
            classList={{ "fc-icon-button-active": listening() }}
            type="button"
            title={t("Voice dictation")}
            aria-label={t("Voice dictation")}
            disabled={!speechRecognition()}
            onClick={toggleVoice}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
              />
              <path
                d="M5 11a7 7 0 0 0 14 0M12 18v3"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
              />
            </svg>
          </button>
          <Show when={primaryAgents(props.agents).length > 0}>
            <div class="fc-segment">
              <For each={primaryAgents(props.agents)}>
                {(entry) => (
                  <button
                    class="fc-segment-item"
                    classList={{ "fc-segment-item-active": props.agent === entry.id }}
                    type="button"
                    onClick={() => props.onAgentChange(entry.id)}
                  >
                    {entry.id}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <ModeMenu value={props.permissionMode} onChange={props.onPermissionModeChange} />
        </div>

        <div class="fc-composer-right">
          <button
            class="fc-model-button"
            type="button"
            aria-label={t("Model")}
            onClick={props.onOpenModelPicker}
          >
            <span class="fc-model-button-label">{props.modelLabel}</span>
          </button>
          <Show when={props.variants.length > 0}>
            <select
              class="fc-model-select"
              ref={(element: HTMLSelectElement) => {
                createEffect(() => {
                  props.variants
                  element.value = props.variantKey ?? ""
                })
              }}
              aria-label={t("Variant")}
              onChange={(event) => props.onVariantChange(event.currentTarget.value)}
            >
              <option value="">{t("Default")}</option>
              <For each={props.variants}>{(variant) => <option value={variant.id}>{variant.id}</option>}</For>
            </select>
          </Show>
          <button
            class="fc-send"
            type="button"
            title={t("Send")}
            aria-label={t("Send")}
            onClick={props.onSend}
            disabled={props.sending || (props.value.trim().length === 0 && props.attachments.length === 0)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                d="M12 19V5M12 5l-6 6M12 5l6 6"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
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
