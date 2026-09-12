import { For, Show, createEffect, createSignal, onCleanup, type Component } from "solid-js"
import type { FileSystemEntry, ModelInfo, ModelVariant } from "@opencode-ai/client"
import type { Attachment, CommandOption } from "../types"

type ComposerProps = {
  value: string
  sending: boolean
  models: ModelInfo[]
  modelKey: string | undefined
  variants: ModelVariant[]
  variantKey: string | undefined
  auto: boolean
  attachments: Attachment[]
  commands: CommandOption[]
  onInput: (value: string) => void
  onSend: () => void
  onModelChange: (key: string) => void
  onVariantChange: (value: string) => void
  onToggleAuto: () => void
  onAttach: (files: File[]) => void
  onRemoveAttachment: (uri: string) => void
  onCommandPick: (name: string) => void
  searchFiles: (query: string) => Promise<FileSystemEntry[]>
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

  const [fileResults, setFileResults] = createSignal<FileSystemEntry[]>([])

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

  onCleanup(() => recognition?.stop())

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    props.onAttach(Array.from(files))
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
      class="oh-composer"
      classList={{ "oh-composer-dragging": dragging() }}
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
      <div class="oh-composer-chips">
        <span class="oh-chip">Local</span>
        <span class="oh-chip">Sin carpeta</span>
        <Show when={props.value.startsWith("!")}>
          <span class="oh-chip oh-chip-active">Shell</span>
        </Show>
      </div>

      <Show when={commandQuery() !== undefined && filteredCommands().length > 0}>
        <div class="oh-command-menu">
          <For each={filteredCommands()}>
            {(command) => (
              <button class="oh-command-item" type="button" onClick={() => props.onCommandPick(command.name)}>
                <span class="oh-command-name">/{command.name}</span>
                <Show when={command.description}>
                  <span class="oh-command-desc">{command.description}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={commandQuery() === undefined && mentionToken() !== undefined && fileResults().length > 0}>
        <div class="oh-command-menu">
          <For each={fileResults()}>
            {(file) => (
              <button class="oh-command-item" type="button" onClick={() => insertMention(file.path)}>
                <span class="oh-command-name">@{file.path}</span>
                <span class="oh-command-desc">{file.type}</span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.attachments.length > 0}>
        <div class="oh-attachments">
          <For each={props.attachments}>
            {(attachment) => (
              <span class="oh-attachment">
                <span class="oh-attachment-name">{attachment.name}</span>
                <button
                  class="oh-attachment-remove"
                  type="button"
                  aria-label={`Quitar ${attachment.name}`}
                  onClick={() => props.onRemoveAttachment(attachment.uri)}
                >
                  ×
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>

      <div class="oh-composer-row">
        <button
          class="oh-attach"
          type="button"
          title="Adjuntar"
          aria-label="Adjuntar"
          onClick={() => fileInput?.click()}
        >
          +
        </button>
        <textarea
          class="oh-input"
          rows={1}
          placeholder="Describe una tarea o haz una pregunta"
          value={props.value}
          onInput={(event) => props.onInput(event.currentTarget.value)}
          onPaste={(event) => {
            const files = event.clipboardData?.files
            if (files && files.length > 0) {
              event.preventDefault()
              handleFiles(files)
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              props.onSend()
            }
          }}
        />
        <button
          class="oh-chip oh-chip-button"
          classList={{ "oh-chip-active": listening() }}
          type="button"
          title="Dictado por voz"
          aria-label="Dictado por voz"
          disabled={!speechRecognition()}
          onClick={toggleVoice}
        >
          Voz
        </button>
        <button
          class="oh-send"
          type="button"
          onClick={props.onSend}
          disabled={props.sending || (props.value.trim().length === 0 && props.attachments.length === 0)}
        >
          Enviar
        </button>
      </div>

      <div class="oh-composer-controls">
        <button
          class="oh-chip oh-chip-button"
          classList={{ "oh-chip-active": props.auto }}
          type="button"
          onClick={props.onToggleAuto}
        >
          Auto
        </button>
        <select
          class="oh-model-select"
          value={props.auto ? "" : (props.modelKey ?? "")}
          disabled={props.auto}
          aria-label="Modelo"
          onChange={(event) => props.onModelChange(event.currentTarget.value)}
        >
          <option value="" disabled>
            Modelo por defecto
          </option>
          <For each={props.models}>
            {(model) => <option value={`${model.providerID}/${model.modelID}`}>{model.name}</option>}
          </For>
        </select>
        <Show when={props.variants.length > 0}>
          <select
            class="oh-model-select"
            value={props.variantKey ?? ""}
            disabled={props.auto}
            aria-label="Variante"
            onChange={(event) => props.onVariantChange(event.currentTarget.value)}
          >
            <option value="">Default</option>
            <For each={props.variants}>{(variant) => <option value={variant.id}>{variant.id}</option>}</For>
          </select>
        </Show>
      </div>

      <input
        ref={fileInput}
        class="oh-file-input"
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
