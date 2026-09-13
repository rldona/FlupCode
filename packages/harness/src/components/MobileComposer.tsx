import { For, Show, createMemo, createSignal, onCleanup, type Component, type JSX } from "solid-js"
import type { AgentInfo, ModelInfo, ModelVariant } from "../engine-types"
import type { Attachment } from "../types"
import { t } from "../i18n"
import { PERMISSION_MODES, permissionMode } from "../permission-modes"
import { speechRecognition, type SpeechRecognitionLike } from "./Composer"

/**
 * The prompt dock on a phone controlling a computer, modelled on the Claude Code mobile app: a
 * rounded field with "+" (attachments, permission mode, agent), the model pill, dictation and send.
 */

type MobileComposerProps = {
  value: string
  sending: boolean
  attachments: Attachment[]
  models: ModelInfo[]
  modelKey: string | undefined
  modelLabel: string
  favorites: string[]
  variants: ModelVariant[]
  variantKey: string | undefined
  agents: AgentInfo[]
  agent: string
  permissionMode: string
  onInput: (value: string) => void
  onSend: () => void
  onAttach: (files: File[]) => void
  onRemoveAttachment: (uri: string) => void
  onModelChange: (providerID: string, id: string) => void
  onVariantChange: (value: string) => void
  onAgentChange: (agent: string) => void
  onPermissionModeChange: (id: string) => void
}

type Sheet = "context" | "mode" | "agent" | "model" | "effort"

const key = (model: ModelInfo) => `${model.providerID}/${model.id}`

const Icon: Component<{ path: string; size?: number }> = (props) => (
  <svg viewBox="0 0 24 24" width={props.size ?? 22} height={props.size ?? 22} aria-hidden="true">
    <path
      d={props.path}
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
)

const BottomSheet: Component<{
  title: string
  onClose: () => void
  onBack?: () => void
  children: JSX.Element
}> = (props) => (
  <div class="fc-sheet-backdrop" onClick={props.onClose}>
    <div
      class="fc-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
      onClick={(event) => event.stopPropagation()}
    >
      <div class="fc-sheet-grip" aria-hidden="true" />
      <div class="fc-sheet-header">
        <button
          class="fc-sheet-icon"
          type="button"
          aria-label={props.onBack ? t("Back") : t("Close")}
          onClick={() => (props.onBack ?? props.onClose)()}
        >
          <Icon path={props.onBack ? "M15 18l-6-6 6-6" : "M6 6l12 12M18 6L6 18"} />
        </button>
        <span class="fc-sheet-title">{props.title}</span>
        <span class="fc-sheet-icon" aria-hidden="true" />
      </div>
      <div class="fc-sheet-body">{props.children}</div>
    </div>
  </div>
)

const Option: Component<{ label: string; detail?: string; active?: boolean; badge?: string; onClick: () => void }> = (
  props,
) => (
  <button
    class="fc-sheet-option"
    classList={{ "fc-sheet-option-active": props.active }}
    type="button"
    onClick={props.onClick}
  >
    <span class="fc-sheet-option-main">
      <span class="fc-sheet-option-label">
        {props.label}
        <Show when={props.badge}>
          <span class="fc-sheet-badge">{props.badge}</span>
        </Show>
      </span>
      <Show when={props.detail}>
        <span class="fc-sheet-option-detail">{props.detail}</span>
      </Show>
    </span>
    <Show when={props.active}>
      <Icon path="M5 12l5 5 9-10" />
    </Show>
  </button>
)

const Row: Component<{ icon: string; label: string; value: string; onClick: () => void }> = (props) => (
  <button class="fc-sheet-row" type="button" onClick={props.onClick}>
    <span class="fc-sheet-row-icon">
      <Icon path={props.icon} />
    </span>
    <span class="fc-sheet-option-main">
      <span class="fc-sheet-option-label">{props.label}</span>
      <span class="fc-sheet-row-value">{props.value}</span>
    </span>
    <Icon path="M9 6l6 6-6 6" size={18} />
  </button>
)

export const MobileComposer: Component<MobileComposerProps> = (props) => {
  const [sheet, setSheet] = createSignal<Sheet>()
  const [query, setQuery] = createSignal("")
  const [listening, setListening] = createSignal(false)
  let recognition: SpeechRecognitionLike | undefined
  onCleanup(() => recognition?.stop())

  const toggleVoice = () => {
    if (listening()) return recognition?.stop()
    const Recognition = speechRecognition()
    if (!Recognition) return
    recognition = new Recognition()
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
  let cameraInput: HTMLInputElement | undefined
  let photoInput: HTMLInputElement | undefined
  let fileInput: HTMLInputElement | undefined

  const close = () => {
    setSheet(undefined)
    setQuery("")
  }
  const pick = (files: FileList | null) => {
    if (files && files.length > 0) props.onAttach(Array.from(files))
    close()
  }

  const primaryAgents = () => props.agents.filter((agent) => agent.mode === "primary" && !agent.hidden)
  const featured = createMemo(() =>
    props.models.filter((model) => props.favorites.includes(key(model)) || key(model) === props.modelKey),
  )
  const others = createMemo(() => {
    const needle = query().trim().toLowerCase()
    return props.models
      .filter((model) => !featured().includes(model))
      .filter((model) => !needle || `${model.name} ${model.id} ${model.providerID}`.toLowerCase().includes(needle))
      .slice(0, 60)
  })
  const effortLabel = () => props.variantKey || t("Default")
  const canSend = () => !props.sending && (props.value.trim().length > 0 || props.attachments.length > 0)

  const modelOption = (model: ModelInfo) => (
    <Option
      label={model.name}
      detail={model.providerID}
      active={key(model) === props.modelKey}
      onClick={() => {
        props.onModelChange(model.providerID, model.id)
        close()
      }}
    />
  )

  return (
    <footer class="fc-mobile-dock">
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

      <div class="fc-mobile-field">
        <textarea
          class="fc-mobile-input"
          rows={1}
          placeholder={t("Type / for commands")}
          value={props.value}
          onInput={(event) => {
            props.onInput(event.currentTarget.value)
            event.currentTarget.style.height = "auto"
            event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 180)}px`
          }}
        />
        <div class="fc-mobile-actions">
          <button
            class="fc-mobile-round"
            type="button"
            aria-label={t("Add context")}
            onClick={() => setSheet("context")}
          >
            <Icon path="M12 5v14M5 12h14" />
          </button>
          <button class="fc-mobile-pill" type="button" aria-label={t("Model")} onClick={() => setSheet("model")}>
            <span class="fc-mobile-pill-label">{props.modelLabel}</span>
          </button>
          <span class="fc-mobile-spacer" />
          <Show when={speechRecognition()}>
            <button
              class="fc-mobile-round"
              classList={{ "fc-mobile-round-on": listening() }}
              type="button"
              aria-label={t("Voice dictation")}
              onClick={toggleVoice}
            >
              <Icon path="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3" />
            </button>
          </Show>
          <button
            class="fc-mobile-round fc-mobile-send"
            type="button"
            aria-label={t("Send")}
            disabled={!canSend()}
            onClick={props.onSend}
          >
            <Icon path="M12 19V5M6 11l6-6 6 6" />
          </button>
        </div>
      </div>

      <Show when={sheet() === "context"}>
        <BottomSheet title={t("Add context")} onClose={close}>
          <div class="fc-sheet-tiles">
            <button class="fc-sheet-tile" type="button" onClick={() => cameraInput?.click()}>
              <Icon path="M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" size={26} />
              <span>{t("Camera")}</span>
            </button>
            <button class="fc-sheet-tile" type="button" onClick={() => photoInput?.click()}>
              <Icon path="M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M15.5 9.5h.01" size={26} />
              <span>{t("Photos")}</span>
            </button>
            <button class="fc-sheet-tile" type="button" onClick={() => fileInput?.click()}>
              <Icon path="M14 3H6v18h12V7zM14 3v4h4M12 17v-6M9 14l3-3 3 3" size={26} />
              <span>{t("Files")}</span>
            </button>
          </div>
          <Row
            icon="M13 2L4 14h7l-1 8 9-12h-7z"
            label={t("Permission")}
            value={t(permissionMode(props.permissionMode).label)}
            onClick={() => setSheet("mode")}
          />
          <Show when={primaryAgents().length > 0}>
            <Row
              icon="M12 3l8 4v6c0 4-3.5 7-8 8-4.5-1-8-4-8-8V7z"
              label={t("Agent")}
              value={props.agent}
              onClick={() => setSheet("agent")}
            />
          </Show>
        </BottomSheet>
      </Show>

      <Show when={sheet() === "mode"}>
        <BottomSheet title={t("Permission")} onClose={close} onBack={() => setSheet("context")}>
          <For each={PERMISSION_MODES}>
            {(mode) => (
              <Option
                label={t(mode.label)}
                detail={t(mode.description)}
                active={props.permissionMode === mode.id}
                onClick={() => {
                  props.onPermissionModeChange(mode.id)
                  close()
                }}
              />
            )}
          </For>
        </BottomSheet>
      </Show>

      <Show when={sheet() === "agent"}>
        <BottomSheet title={t("Agent")} onClose={close} onBack={() => setSheet("context")}>
          <For each={primaryAgents()}>
            {(entry) => (
              <Option
                label={entry.id}
                detail={entry.description}
                active={props.agent === entry.id}
                onClick={() => {
                  props.onAgentChange(entry.id)
                  close()
                }}
              />
            )}
          </For>
        </BottomSheet>
      </Show>

      <Show when={sheet() === "model"}>
        <BottomSheet title={t("Select model")} onClose={close}>
          <div class="fc-sheet-group">
            <For each={featured()}>{modelOption}</For>
          </div>
          <Show when={props.variants.length > 0}>
            <Row
              icon="M12 7v5l3 2M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4"
              label={t("Effort")}
              value={effortLabel()}
              onClick={() => setSheet("effort")}
            />
          </Show>
          <span class="fc-sheet-section">{t("Other models")}</span>
          <input
            class="fc-sheet-search"
            value={query()}
            placeholder={t("Search models")}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <div class="fc-sheet-group">
            <For each={others()}>{modelOption}</For>
          </div>
        </BottomSheet>
      </Show>

      <Show when={sheet() === "effort"}>
        <BottomSheet title={t("Effort")} onClose={close} onBack={() => setSheet("model")}>
          <div class="fc-sheet-group">
            <Option
              label={t("Default")}
              active={!props.variantKey}
              onClick={() => {
                props.onVariantChange("")
                close()
              }}
            />
            <For each={props.variants}>
              {(variant) => (
                <Option
                  label={variant.id}
                  active={props.variantKey === variant.id}
                  onClick={() => {
                    props.onVariantChange(variant.id)
                    close()
                  }}
                />
              )}
            </For>
          </div>
        </BottomSheet>
      </Show>

      <input
        ref={cameraInput}
        class="fc-file-input"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(event) => pick(event.currentTarget.files)}
      />
      <input
        ref={photoInput}
        class="fc-file-input"
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => pick(event.currentTarget.files)}
      />
      <input
        ref={fileInput}
        class="fc-file-input"
        type="file"
        multiple
        onChange={(event) => pick(event.currentTarget.files)}
      />
    </footer>
  )
}
