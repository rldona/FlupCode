import { For, Show, createEffect, createSignal, onCleanup, onMount, type Component, type JSX } from "solid-js"
import type { AgentInfo, ModelInfo } from "../engine-types"
import { t } from "../i18n"
import { isDeprecated } from "../model-catalog"
import { Icon, type IconName } from "./Icon"

/** A dock button with a menu that opens above it and closes on outside clicks or Escape. */
const DockPopover: Component<{
  class: string
  label: JSX.Element
  title: string
  align?: "left" | "right"
  /** Where the menu opens. The dock sits at the bottom and rises; a row inside a scrolling panel drops. */
  placement?: "up" | "down"
  disabled?: boolean
  children: (close: () => void) => JSX.Element
}> = (props) => {
  const [open, setOpen] = createSignal(false)
  let root: HTMLDivElement | undefined

  // Disabling mid-turn must also drop an already open popover, or the menu stays clickable.
  createEffect(() => {
    if (props.disabled) setOpen(false)
  })

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
        <div
          class="fc-dock-popover"
          classList={{
            "fc-dock-popover-right": props.align === "right",
            "fc-dock-popover-down": props.placement === "down",
          }}
          role="menu"
        >
          {props.children(() => setOpen(false))}
        </div>
      </Show>
    </div>
  )
}

const MenuItem: Component<{
  label: string
  icon?: JSX.Element
  hint?: JSX.Element
  /** A short marker before the label, e.g. that the model is deprecated. */
  badge?: string
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
    <Show when={props.badge}>
      <span class="fc-dock-item-badge">{props.badge}</span>
    </Show>
    <span class="fc-dock-item-label">{props.label}</span>
    <Show when={props.hint}>
      <span class="fc-dock-item-hint">{props.hint}</span>
    </Show>
    <Show when={props.active}>
      <span class="fc-dock-item-check" aria-hidden="true">
        <Icon name="check" />
      </span>
    </Show>
  </button>
)

/** Hammer for build, bulb for plan; every other agent gets a robot. */
const AGENT_ICONS: Record<string, IconName> = {
  build: "hammer",
  plan: "bulb",
}

/** The dock icon for an agent: the built-in's own, a robot for anything else. */
export function agentIcon(id: string): IconName {
  return AGENT_ICONS[id] ?? "robot"
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

export const AddMenu: Component<{
  canAddFolder: boolean
  onAddFiles: () => void
  onAddFolder: () => void
  /** Left out in chats, which have no commands. */
  onSlashCommands?: () => void
}> = (props) => (
  <DockPopover class="fc-dock-icon" title={t("Add")} label={<Icon name="plus" size={20} weight={1.8} />}>
    {(close) => (
      <>
        <MenuItem
          icon={<Icon name="clip" size={18} weight={1.8} />}
          label={t("Add files or photos")}
          hint={isMac ? "⌘U" : "Ctrl+U"}
          onClick={() => {
            close()
            props.onAddFiles()
          }}
        />
        <Show when={props.canAddFolder}>
          <MenuItem
            icon={<Icon name="folder" size={18} weight={1.8} />}
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
              icon={<Icon name="slash" size={18} weight={1.8} />}
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
  /** A turn is running: switching the model now would break it. */
  disabled?: boolean
  /** See `DockPopover`; the settings row opens downward. */
  placement?: "up" | "down"
  onSelect: (providerID: string, id: string) => void
  onMore: () => void
  /** An entry above the shortlist for "no model of my own", like the automatic suggestion model. */
  autoLabel?: string
  onAuto?: () => void
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
      placement={props.placement}
      disabled={props.disabled}
      label={<span class="fc-dock-text-label">{props.label}</span>}
    >
      {(close) => (
        <>
          <Show when={props.autoLabel}>
            <MenuItem
              label={props.autoLabel!}
              active={!props.selectedKey}
              onClick={() => {
                close()
                props.onAuto?.()
              }}
            />
            <div class="fc-dock-separator" />
          </Show>
          <For each={shortlist()}>
            {(model) => (
              <MenuItem
                label={model.name}
                badge={isDeprecated(model) ? t("Deprecated") : undefined}
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
            hint={<Icon name="chevron-right" />}
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
            icon={<Icon name={agentIcon(agent.id)} size={18} weight={1.8} />}
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
