import { For, Show, createSignal, onCleanup, onMount, type Component, type JSX } from "solid-js"
import type { AgentInfo, ModelInfo } from "../engine-types"
import { t } from "../i18n"

/** A dock button with a menu that opens above it and closes on outside clicks or Escape. */
const DockPopover: Component<{
  class: string
  label: JSX.Element
  title: string
  align?: "left" | "right"
  disabled?: boolean
  children: (close: () => void) => JSX.Element
}> = (props) => {
  const [open, setOpen] = createSignal(false)
  let root: HTMLDivElement | undefined

  onMount(() => {
    const onPointer = (event: MouseEvent) => {
      if (root && !root.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onPointer)
    document.addEventListener("keydown", onKey)
    onCleanup(() => {
      document.removeEventListener("mousedown", onPointer)
      document.removeEventListener("keydown", onKey)
    })
  })

  return (
    <div class="fc-dock-menu" ref={root}>
      <button
        class={props.class}
        classList={{ "fc-dock-open": open() }}
        type="button"
        title={props.title}
        aria-label={props.title}
        aria-haspopup="menu"
        aria-expanded={open()}
        disabled={props.disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {props.label}
      </button>
      <Show when={open()}>
        <div class="fc-dock-popover" classList={{ "fc-dock-popover-right": props.align === "right" }} role="menu">
          {props.children(() => setOpen(false))}
        </div>
      </Show>
    </div>
  )
}

const MenuItem: Component<{
  label: string
  icon?: JSX.Element
  hint?: string
  active?: boolean
  onClick: () => void
}> = (props) => (
  <button
    class="fc-dock-item"
    classList={{ "fc-dock-item-active": props.active }}
    type="button"
    role="menuitem"
    onClick={props.onClick}
  >
    <Show when={props.icon}>
      <span class="fc-dock-item-icon">{props.icon}</span>
    </Show>
    <span class="fc-dock-item-label">{props.label}</span>
    <Show when={props.hint}>
      <span class="fc-dock-item-hint">{props.hint}</span>
    </Show>
    <Show when={props.active}>
      <span class="fc-dock-item-check" aria-hidden="true">
        ✓
      </span>
    </Show>
  </button>
)

export const DockIcon: Component<{ path: string; size?: number }> = (props) => (
  <svg viewBox="0 0 24 24" width={props.size ?? 18} height={props.size ?? 18} aria-hidden="true">
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

const ICONS = {
  plus: "M12 5v14M5 12h14",
  clip: "M21 11.5 12.5 20a5 5 0 0 1-7-7L14 4.5a3.3 3.3 0 0 1 4.7 4.7L10.2 17.7a1.7 1.7 0 0 1-2.4-2.4L15.5 7.6",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
  slash: "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM14 8l-4 8",
  hammer:
    "M15 12l-8.373 8.373a1 1 0 1 1-3-3L12 9M18 15l4-4M21.5 11.5l-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5",
  bulb: "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4",
}

/** Hammer for build, bulb for plan; other agents get no icon. */
const AGENT_ICONS: Record<string, string> = {
  build: ICONS.hammer,
  plan: ICONS.bulb,
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

export const AddMenu: Component<{
  canAddFolder: boolean
  onAddFiles: () => void
  onAddFolder: () => void
  /** Left out in chats, which have no commands. */
  onSlashCommands?: () => void
}> = (props) => (
  <DockPopover class="fc-dock-icon" title={t("Add")} label={<DockIcon path={ICONS.plus} size={20} />}>
    {(close) => (
      <>
        <MenuItem
          icon={<DockIcon path={ICONS.clip} />}
          label={t("Add files or photos")}
          hint={isMac ? "⌘U" : "Ctrl+U"}
          onClick={() => {
            close()
            props.onAddFiles()
          }}
        />
        <Show when={props.canAddFolder}>
          <MenuItem
            icon={<DockIcon path={ICONS.folder} />}
            label={t("Add folder")}
            onClick={() => {
              close()
              props.onAddFolder()
            }}
          />
        </Show>
        <Show when={props.onSlashCommands}>
          {(open) => (
            <MenuItem
              icon={<DockIcon path={ICONS.slash} />}
              label={t("Slash commands")}
              onClick={() => {
                close()
                open()()
              }}
            />
          )}
        </Show>
      </>
    )}
  </DockPopover>
)

const modelKey = (model: ModelInfo) => `${model.providerID}/${model.id}`

export const ModelMenu: Component<{
  label: string
  models: ModelInfo[]
  selectedKey: string | undefined
  favorites: string[]
  onSelect: (providerID: string, id: string) => void
  onMore: () => void
}> = (props) => {
  // The current model and favourites, like Claude Code's short list; everything else is under "More models".
  const shortlist = () => {
    const byKey = new Map(props.models.map((model) => [modelKey(model), model]))
    const keys = [...new Set([props.selectedKey, ...props.favorites].filter((key): key is string => !!key))]
    return keys.flatMap((key) => (byKey.has(key) ? [byKey.get(key)!] : [])).slice(0, 6)
  }
  return (
    <DockPopover
      class="fc-dock-text"
      title={t("Model")}
      align="right"
      label={<span class="fc-dock-text-label">{props.label}</span>}
    >
      {(close) => (
        <>
          <For each={shortlist()}>
            {(model) => (
              <MenuItem
                label={model.name}
                hint={model.providerID}
                active={modelKey(model) === props.selectedKey}
                onClick={() => {
                  close()
                  props.onSelect(model.providerID, model.id)
                }}
              />
            )}
          </For>
          <Show when={shortlist().length > 0}>
            <div class="fc-dock-separator" />
          </Show>
          <MenuItem
            label={t("More models")}
            hint="›"
            onClick={() => {
              close()
              props.onMore()
            }}
          />
        </>
      )}
    </DockPopover>
  )
}

export const AgentMenu: Component<{
  agents: AgentInfo[]
  value: string
  onChange: (id: string) => void
}> = (props) => (
  <DockPopover
    class="fc-dock-text"
    title={t("Agent")}
    label={
      <>
        <span class="fc-dock-text-label fc-dock-capitalize">{props.value}</span>
      </>
    }
  >
    {(close) => (
      <For each={props.agents}>
        {(agent) => (
          <MenuItem
            icon={AGENT_ICONS[agent.id] ? <DockIcon path={AGENT_ICONS[agent.id]!} /> : undefined}
            label={agent.id.charAt(0).toUpperCase() + agent.id.slice(1)}
            active={agent.id === props.value}
            onClick={() => {
              close()
              props.onChange(agent.id)
            }}
          />
        )}
      </For>
    )}
  </DockPopover>
)
