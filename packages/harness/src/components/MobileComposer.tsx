import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component, type JSX } from "solid-js"
import type { AgentInfo, FileSystemEntry, ModelInfo, ModelVariant } from "../engine-types"
import type { Attachment, CommandOption } from "../types"
import type { Delivery } from "../pending-prompts"
import { t } from "../i18n"
import { ComposerMenu } from "./ComposerMenu"
import { commandBadge, filterCommands, mentionItems, mentionToken, pickMention, refsIn, slashQuery, type MentionItem } from "../composer-menus"
import { chipRefs, type ContextChip } from "../context-chip"
import { ContextChips } from "./ContextChips"
import { effortLabel } from "../effort"
import { PERMISSION_MODES, permissionMode } from "../permission-modes"
import { primaryAgents } from "../agents"
import type { AppView, ChatClass } from "../chat"
import { dictationAvailable } from "../dictation"
import { isCowork, isPlainChat, useDictation } from "../composer-core"
import { isDeprecated } from "../model-catalog"
import { Modal } from "./Modal"
import { Icon, type IconName } from "./Icon"

/**
 * The prompt dock on a phone controlling a computer, modelled on the Claude Code mobile app: a
 * rounded field with "+" (attachments, permission mode, agent), the model pill, dictation and send.
 */

type MobileComposerProps = {
  /** Chats hide the permission and agent rows. */
  mode: AppView
  /** In the Chat tab, the class of the conversation: "chat" without a project, "cowork" with one. */
  chatClass?: ChatClass
  onChatClassChange?: (value: ChatClass) => void
  /** A conversation is open: switching then starts a new one, and the switch says so. */
  sessionOpen?: boolean
  /** The open conversation is answering; the switch waits, like the composer. */
  generating?: boolean
  /** The engine is folding the session: deny a prompt until that turn ends. */
  compacting?: boolean
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
  /** Artifacts the `@` menu can reach, alongside files and agents (H-26, HF-6). */
  artifacts?: Array<{ id?: string; path?: string; title?: string; kind?: string }>
  /** Context packs, and a way to save the draft's refs as one (H-26). */
  packs?: Array<{ name: string; refs: string[] }>
  onSavePack?: (refs: string[]) => void
  /** What the reader pointed at (UX-05): the same chips as the desktop composer's. */
  chips?: ContextChip[]
  onRemoveChip?: (id: string) => void
  onAddChips?: (chips: ContextChip[]) => void
  agent: string
  permissionMode: string
  /** Commands for the `/` menu, the same list the desktop composer gets (H-26). */
  commands?: CommandOption[]
  onInput: (value: string) => void
  onSend: () => void
  /** Stops the turn that is running, when there is one (H-26). */
  onStop?: () => void
  /** What happens to a prompt sent while the agent works (H-26). */
  delivery?: Delivery
  onDeliveryChange?: (value: Delivery) => void
  onCommandPick?: (name: string) => void
  onCommandRun?: (name: string) => void
  searchFiles?: (query: string) => Promise<FileSystemEntry[]>
  onAttach: (files: File[]) => void
  onRemoveAttachment: (uri: string) => void
  onModelChange: (providerID: string, id: string) => void
  onVariantChange: (value: string) => void
  onAgentChange: (agent: string) => void
  onPermissionModeChange: (id: string) => void
}

type Sheet = "context" | "mode" | "agent" | "model" | "effort" | "delivery"

const key = (model: ModelInfo) => `${model.providerID}/${model.id}`

const BottomSheet: Component<{
  title: string
  onClose: () => void
  onBack?: () => void
  children: JSX.Element
}> = (props) => (
  <Modal onClose={props.onClose} backdropClass="fc-sheet-backdrop" class="fc-sheet" label={props.title}>
    <div class="fc-sheet-grip" aria-hidden="true" />
    <div class="fc-sheet-header">
      <button
        class="fc-sheet-icon"
        type="button"
        aria-label={props.onBack ? t("Back") : t("Close")}
        onClick={() => (props.onBack ?? props.onClose)()}
      >
        <Icon name={props.onBack ? "chevron-left" : "close"} size={22} weight={1.8} />
      </button>
      <span class="fc-sheet-title">{props.title}</span>
      <span class="fc-sheet-icon" aria-hidden="true" />
    </div>
    <div class="fc-sheet-body">{props.children}</div>
  </Modal>
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
      <Icon name="check" size={22} weight={1.8} />
    </Show>
  </button>
)

const Row: Component<{ icon: IconName; label: string; value: string; disabled?: boolean; onClick: () => void }> = (
  props,
) => (
  <button class="fc-sheet-row" type="button" disabled={props.disabled} onClick={props.onClick}>
    <span class="fc-sheet-row-icon">
      <Icon name={props.icon} size={22} weight={1.8} />
    </span>
    <span class="fc-sheet-option-main">
      <span class="fc-sheet-option-label">{props.label}</span>
      <span class="fc-sheet-row-value">{props.value}</span>
    </span>
    <Icon name="chevron-right" size={18} weight={1.8} />
  </button>
)

export const MobileComposer: Component<MobileComposerProps> = (props) => {
  const [sheet, setSheet] = createSignal<Sheet>()
  const [query, setQuery] = createSignal("")
  const { listening, toggle: toggleVoice } = useDictation((text) => props.onInput(text))
  // Cowork is a chat in the Chat tab, but it earns the permission row Code has; only a plain chat
  // hides it. See ADR-0013.
  const chat = () => isPlainChat(props.mode, props.chatClass)
  const cowork = () => isCowork(props.chatClass)
  // With a conversation open, only the other class starts something new, so only it says "New".
  const chatLabel = () => (props.sessionOpen && cowork() ? t("New chat") : t("Chat"))
  const coworkLabel = () => (props.sessionOpen && !cowork() ? t("New cowork") : t("Cowork"))

  // The same `/` and `@` menus the desktop composer has, from the same rules (H-26).
  const [fileResults, setFileResults] = createSignal<FileSystemEntry[]>([])
  const [commandIndex, setCommandIndex] = createSignal(0)
  const [dismissedAt, setDismissedAt] = createSignal<string>()
  const commandQuery = () => slashQuery(props.value, chat())
  const filteredCommands = () => filterCommands(props.commands ?? [], commandQuery())
  const mentionQuery = () => mentionToken(props.value, chat())
  const mentionCandidates = () =>
    mentionItems(mentionQuery() ?? "", {
      files: fileResults(),
      agents: primaryAgents(props.agents),
      artifacts: props.artifacts ?? [],
      packs: props.packs ?? [],
    })
  createEffect(() => {
    filteredCommands()
    setCommandIndex(0)
  })
  createEffect(() => {
    const token = mentionQuery()
    if (token === undefined || commandQuery() !== undefined) {
      setFileResults([])
      return
    }
    const handle = setTimeout(async () => {
      try {
        setFileResults((await props.searchFiles?.(token)) ?? [])
      } catch {
        setFileResults([])
      }
    }, 150)
    onCleanup(() => clearTimeout(handle))
  })
  createEffect(() => {
    const dismissed = dismissedAt()
    if (dismissed !== undefined && props.value !== dismissed) setDismissedAt(undefined)
  })
  const menusDismissed = () => dismissedAt() !== undefined && dismissedAt() === props.value
  const commandMenuOpen = () => !menusDismissed() && commandQuery() !== undefined && filteredCommands().length > 0
  // What "save as a pack" saves: the chips' refs, then any typed in the draft.
  const draftRefs = () => [...new Set([...chipRefs(props.chips ?? []), ...refsIn(props.value)])]
  const menuCanSavePack = () => !!props.onSavePack && draftRefs().length > 0
  const mentionMenuOpen = () =>
    !menusDismissed() &&
    commandQuery() === undefined &&
    mentionQuery() !== undefined &&
    (mentionCandidates().length > 0 || menuCanSavePack())
  const closeMenus = () => {
    if (commandMenuOpen()) props.onInput("")
    else setDismissedAt(props.value)
  }
  const insertMention = (item: MentionItem) => {
    const picked = pickMention(props.value, item)
    props.onInput(picked.value)
    if (picked.chips.length > 0) props.onAddChips?.(picked.chips)
    setFileResults([])
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

  const featured = createMemo(() =>
    props.models.filter((model) => props.favorites.includes(key(model)) || key(model) === props.modelKey),
  )
  const others = createMemo(() => {
    const needle = query().trim().toLowerCase()
    return (
      props.models
        .filter((model) => !featured().includes(model))
        .filter((model) => !needle || `${model.name} ${model.id} ${model.providerID}`.toLowerCase().includes(needle))
        // Deprecated models stay pickable, but below the ones still being released (the sort is stable).
        .sort((a, b) => (isDeprecated(a) ? 1 : 0) - (isDeprecated(b) ? 1 : 0))
        .slice(0, 60)
    )
  })
  const currentEffort = () => (props.variantKey ? effortLabel(props.variantKey) : t("Default"))
  const canSend = () =>
    !props.compacting &&
    !props.sending &&
    (props.value.trim().length > 0 || props.attachments.length > 0 || (props.chips ?? []).length > 0)

  const modelOption = (model: ModelInfo) => (
    <Option
      label={model.name}
      detail={model.providerID}
      badge={isDeprecated(model) ? t("Deprecated") : undefined}
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
                  <Icon name="close" />
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>

      <ContextChips chips={props.chips ?? []} onRemove={props.onRemoveChip} />

      <div class="fc-mobile-field">
        <Show when={commandMenuOpen()}>
          <ComposerMenu
            items={filteredCommands().map((command) => ({
              key: command.name,
              label: `/${command.name}`,
              hint: command.description,
              badge: commandBadge(command.source),
              group: command.group,
              disabled: command.disabled,
              soon: command.disabled,
            }))}
            active={commandIndex()}
            onHover={setCommandIndex}
            onPick={(index) => {
              const command = filteredCommands()[index]
              if (command) props.onCommandPick?.(command.name)
            }}
          />
        </Show>
        <Show when={mentionMenuOpen()}>
          <ComposerMenu
            items={mentionCandidates().map((item) => ({
              key: `${item.kind}:${item.value}`,
              label: item.label,
              hint: item.hint,
            }))}
            onPick={(index) => {
              const item = mentionCandidates()[index]
              if (item) insertMention(item)
            }}
            footer={
              <Show when={menuCanSavePack()}>
                <button
                  class="fc-command-item fc-command-save"
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => props.onSavePack?.(draftRefs())}
                >
                  <span class="fc-command-name">{t("Save these as a pack")}</span>
                </button>
              </Show>
            }
          />
        </Show>
        <textarea
          class="fc-mobile-input"
          rows={1}
          placeholder={chat() ? t("Write a message…") : t("Type / for commands")}
          value={props.value}
          onInput={(event) => {
            props.onInput(event.currentTarget.value)
            event.currentTarget.style.height = "auto"
            event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 180)}px`
          }}
          onKeyDown={(event) => {
            // The same keys the desktop field answers: arrows walk the menu, Enter sends.
            if (commandMenuOpen()) {
              if (event.key === "ArrowDown") {
                event.preventDefault()
                const count = filteredCommands().length
                setCommandIndex((index) => (index + 1) % count)
                return
              }
              if (event.key === "ArrowUp") {
                event.preventDefault()
                const count = filteredCommands().length
                setCommandIndex((index) => (index - 1 + count) % count)
                return
              }
              if (event.key === "Escape") {
                event.preventDefault()
                closeMenus()
                return
              }
              if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault()
                const command = filteredCommands()[commandIndex()]
                if (command) props.onCommandRun?.(command.name)
                return
              }
            }
            if (mentionMenuOpen() && event.key === "Escape") {
              event.preventDefault()
              closeMenus()
              return
            }
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
              event.preventDefault()
              if (canSend()) props.onSend()
            }
          }}
        />
        <div class="fc-mobile-actions">
          <button
            class="fc-mobile-round"
            type="button"
            aria-label={t("Add context")}
            onClick={() => setSheet("context")}
          >
            <Icon name="plus" size={22} weight={1.8} />
          </button>
          <button class="fc-mobile-pill" type="button" aria-label={t("Model")} onClick={() => setSheet("model")}>
            <span class="fc-mobile-pill-label">{props.modelLabel}</span>
            <Show when={props.variantKey}>
              {(variant) => <span class="fc-mobile-pill-effort">{effortLabel(variant())}</span>}
            </Show>
          </button>
          <span class="fc-mobile-spacer" />
          <Show when={dictationAvailable()}>
            <button
              class="fc-mobile-round"
              classList={{ "fc-mobile-round-on": listening() }}
              type="button"
              aria-label={t("Voice dictation")}
              onClick={() => toggleVoice(props.value)}
            >
              <Icon name="mic" size={22} weight={1.8} />
            </button>
          </Show>
          <Show
            when={props.generating && props.onStop}
            fallback={
              <button
                class="fc-mobile-round fc-mobile-send"
                type="button"
                aria-label={t("Send")}
                disabled={!canSend()}
                onClick={props.onSend}
              >
                <Icon name="arrow-up" size={22} weight={1.8} />
              </button>
            }
          >
            <button class="fc-mobile-round fc-mobile-stop" type="button" aria-label={t("Stop")} onClick={props.onStop}>
              <Icon name="stop" size={22} weight={1.8} />
            </button>
          </Show>
        </div>
      </div>

      <Show when={sheet() === "context"}>
        <BottomSheet title={t("Add context")} onClose={close}>
          <div class="fc-sheet-tiles">
            <button class="fc-sheet-tile" type="button" onClick={() => cameraInput?.click()}>
              <Icon name="camera" size={26} weight={1.8} />
              <span>{t("Camera")}</span>
            </button>
            <button class="fc-sheet-tile" type="button" onClick={() => photoInput?.click()}>
              <Icon name="image" size={26} weight={1.8} />
              <span>{t("Photos")}</span>
            </button>
            <button class="fc-sheet-tile" type="button" onClick={() => fileInput?.click()}>
              <Icon name="upload" size={26} weight={1.8} />
              <span>{t("Files")}</span>
            </button>
          </div>
          <Show when={props.mode === "chat" && !!props.onChatClassChange}>
            <div class="fc-chat-mode fc-chat-mode-sheet" role="tablist" aria-label={t("Conversation")}>
              <button
                class="fc-chat-mode-option"
                classList={{ "fc-chat-mode-option-active": !cowork() }}
                type="button"
                role="tab"
                aria-selected={!cowork()}
                disabled={props.generating}
                onClick={() => props.onChatClassChange?.("chat")}
              >
                {chatLabel()}
              </button>
              <button
                class="fc-chat-mode-option"
                classList={{ "fc-chat-mode-option-active": cowork() }}
                type="button"
                role="tab"
                aria-selected={cowork()}
                disabled={props.generating}
                onClick={() => props.onChatClassChange?.("cowork")}
              >
                {coworkLabel()}
              </button>
            </div>
          </Show>
          <Show when={!chat()}>
            <Row
              icon="bolt"
              label={t("Permission")}
              value={t(permissionMode(props.permissionMode).label)}
              onClick={() => setSheet("mode")}
            />
          </Show>
          <Show when={!chat() && !cowork() && primaryAgents(props.agents).length > 0}>
            <Row
              icon="shield"
              label={t("Agent")}
              value={props.agent}
              onClick={() => setSheet("agent")}
            />
          </Show>
          <Show when={!chat() && props.delivery && props.onDeliveryChange}>
            <Row
              icon="lines"
              label={t("While the agent works")}
              value={props.delivery === "queue" ? t("Queue") : t("Steer")}
              onClick={() => setSheet("delivery")}
            />
          </Show>
        </BottomSheet>
      </Show>

      <Show when={sheet() === "delivery"}>
        <BottomSheet title={t("While the agent works")} onClose={close} onBack={() => setSheet("context")}>
          <Option
            label={t("Steer")}
            detail={t("Redirect the turn that is running")}
            active={props.delivery !== "queue"}
            onClick={() => {
              props.onDeliveryChange?.("steer")
              close()
            }}
          />
          <Option
            label={t("Queue")}
            detail={t("Wait until the session is done")}
            active={props.delivery === "queue"}
            onClick={() => {
              props.onDeliveryChange?.("queue")
              close()
            }}
          />
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
          <For each={primaryAgents(props.agents)}>
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
          <Row
            icon="history"
            label={t("Effort")}
            value={props.variants.length > 0 ? currentEffort() : t("Not available for this model")}
            disabled={props.variants.length === 0}
            onClick={() => setSheet("effort")}
          />
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
                  label={effortLabel(variant.id)}
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
