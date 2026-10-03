import { createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { STORAGE_KEYS, readStorage, writeStorage } from "../../storage"
import {
  KEYBIND_ACTIONS,
  loadKeybinds,
  matchesKeybind,
  withKeybind,
  type KeybindAction,
  type Keybinds,
} from "../../keybinds"
import { SIDEBAR_WIDTH_DEFAULT } from "../../components/Sidebar"
import { CONTEXT_PANEL_WIDTH } from "../../components/RightAside"
import { WORKSPACE_WIDTH_DEFAULT } from "../../components/WorkspacePanels"
import { desktopRemote, remote, touchDevice } from "../../remote"
import { DESTINATIONS } from "../../navigation"
import type { AppStores } from "../../app-context"

// The FlupCode palette is the default, so anything unknown falls back to it. "default" was the
// neutral palette's id before it was renamed to "classic".
function readColorTheme() {
  const saved = readStorage<string>(STORAGE_KEYS.colorTheme, "flupcode")
  if (saved === "classic" || saved === "default") return "classic"
  if (saved === "sublime") return "sublime"
  if (saved === "sublime-dark") return "sublime-dark"
  if (saved === "github") return "github"
  if (saved === "copilot") return "copilot"
  if (saved === "code") return "code"
  if (saved === "vercel") return "vercel"
  return "flupcode"
}

/** Whether a key event is going into a text field, where a bare shortcut must not fire. */
function isTypingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null
  if (!element) return false
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable
}

export function createSettings(app: AppStores) {
  const [collapsed, setCollapsed] = createSignal(readStorage(STORAGE_KEYS.sidebarCollapsed, false))
  // Closed until there is something to watch, or until the reader opens it: the conversation gets
  // the room, and the panel's own effect opens it for work and closes it when the work is done.
  const [contextHidden, setContextHidden] = createSignal(readStorage(STORAGE_KEYS.contextPanelHidden, true))
  const [contextWidth, setContextWidth] = createSignal(
    readStorage(STORAGE_KEYS.contextPanelWidth, CONTEXT_PANEL_WIDTH.default),
  )
  const [narrow, setNarrow] = createSignal(typeof window !== "undefined" && window.innerWidth < 768)
  // Phones controlling a computer get their own layout: a sessions home and a focused session screen.
  const mobileRemote = () => touchDevice && !desktopRemote() && !!remote.activeHost()
  const [sidebarWidth, setSidebarWidth] = createSignal(readStorage(STORAGE_KEYS.sidebarWidth, SIDEBAR_WIDTH_DEFAULT))
  // The integrated browser panel is gone: a stored kind would open a panel with nothing in it.
  const [panels, setPanels] = createSignal<string[]>(
    readStorage<string[]>(STORAGE_KEYS.workspacePanels, []).filter((kind) => kind !== "browser"),
  )
  const [workspaceWidth, setWorkspaceWidth] = createSignal(
    readStorage(STORAGE_KEYS.workspaceWidth, WORKSPACE_WIDTH_DEFAULT),
  )
  const [displayName, setDisplayName] = createSignal(readStorage(STORAGE_KEYS.displayName, ""))
  const [favorites, setFavorites] = createSignal<string[]>(readStorage<string[]>(STORAGE_KEYS.favoriteModels, []))
  const [showTools, setShowTools] = createSignal(readStorage(STORAGE_KEYS.showTools, true))
  const toggleTools = () => {
    const next = !showTools()
    setShowTools(next)
    writeStorage(STORAGE_KEYS.showTools, next)
  }
  // The model's thinking stays out of the conversation unless it is asked for, as in Claude Code.
  const [showReasoning, setShowReasoning] = createSignal(readStorage(STORAGE_KEYS.showReasoning, false))
  const toggleReasoning = () => {
    const next = !showReasoning()
    setShowReasoning(next)
    writeStorage(STORAGE_KEYS.showReasoning, next)
  }
  // Open sessions as a tab strip (H-36). Off by default: a window that opens one session at a time
  // reads cleaner, and the strip is a preference rather than the shape of the app.
  const [sessionTabsEnabled, setSessionTabsEnabled] = createSignal(readStorage(STORAGE_KEYS.sessionTabsEnabled, false))
  const toggleSessionTabs = () => {
    const next = !sessionTabsEnabled()
    setSessionTabsEnabled(next)
    writeStorage(STORAGE_KEYS.sessionTabsEnabled, next)
  }
  // Dismissed in this session only: a server left needing auth is worth offering again next launch.
  const [mcpAuthNoticeDismissed, setMcpAuthNoticeDismissed] = createSignal(false)
  const [notifications, setNotifications] = createSignal(readStorage(STORAGE_KEYS.notifications, false))
  const [keybinds, setKeybinds] = createSignal<Keybinds>(
    loadKeybinds(
      readStorage<Partial<Keybinds> | undefined>(STORAGE_KEYS.keybinds, undefined),
      readStorage<string | undefined>(STORAGE_KEYS.paletteKey, undefined),
    ),
  )
  const [onboarded, setOnboarded] = createSignal(readStorage(STORAGE_KEYS.onboarded, false))
  const [theme, setTheme] = createSignal(readStorage(STORAGE_KEYS.theme, "system"))
  const [colorTheme, setColorTheme] = createSignal(readColorTheme())
  /** The desktop window whose title bar this page replaces. Not Linux, which keeps its own frame. */
  const desktopWindow = () => typeof window !== "undefined" && window.flupcode?.ownsTitleBar === true
  // Windows paints its own window buttons over the strip, and cannot read the page's palette. It is
  // told, whenever the palette or the light/dark choice changes, in the colours actually computed.
  createEffect(() => {
    theme()
    colorTheme()
    const set = window.flupcode?.setTitleBar
    if (!set || window.flupcode?.platform !== "win32") return
    const styles = getComputedStyle(document.documentElement)
    const color = styles.getPropertyValue("--fc-sidebar").trim()
    const symbolColor = styles.getPropertyValue("--fc-text").trim()
    if (color && symbolColor) void set({ color, symbolColor }).catch(() => undefined)
  })

  // Every editable shortcut runs here, read from the registry, so one changed in Settings takes
  // effect without a reload (H-24). The old code hard-coded each one.
  const runShortcut = (action: KeybindAction) => {
    // A shortcut that opens a destination opens it the way every other entry point does (UX-01).
    const target = DESTINATIONS.find((entry) => entry.keybind === action)
    if (target) return app.router.go(target.id)
    if (action === "palette") return app.router.setPaletteOpen(true)
    if (action === "toggleSidebar") return toggleSidebar()
    if (action === "toggleContextPanel") return toggleContextPanel()
    if (action === "newSession") return app.sessions.newSession()
    if (action === "compact") return app.sessions.compactSession()
    if (action === "split" && app.sessions.selected() && !app.sessions.splitActive())
      return app.sessions.openSplit(app.sessions.selected()!)
  }
  createEffect(() => {
    const bindings = keybinds()
    const handler = (event: KeyboardEvent) => {
      if (event.repeat) return
      const typing = isTypingTarget(event.target)
      for (const action of KEYBIND_ACTIONS) {
        const binding = bindings[action]
        if (!binding || !matchesKeybind(binding, event)) continue
        // A binding with no modifier must not fire while the reader is typing into a field.
        if (typing && !binding.includes("mod") && !binding.includes("alt")) continue
        event.preventDefault()
        runShortcut(action)
        return
      }
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  createEffect(() => {
    const query = window.matchMedia("(max-width: 768px)")
    const update = () => setNarrow(query.matches)
    update()
    query.addEventListener("change", update)
    onCleanup(() => query.removeEventListener("change", update))
  })

  // Narrow windows auto-collapse the sidebar; unlike the right panel (pure CSS, so it
  // reappears on its own), this writes a signal that would stick. Remember the wide preference
  // and put it back when the window grows again. Untracked: opening the drawer while narrow is
  // the reader's own doing and must not re-trigger the auto-collapse.
  let wideCollapsed: boolean | undefined
  createEffect(() => {
    if (narrow()) {
      if (wideCollapsed === undefined) wideCollapsed = untrack(collapsed)
      setCollapsed(true)
      return
    }
    if (wideCollapsed === undefined) return
    setCollapsed(wideCollapsed)
    writeStorage(STORAGE_KEYS.sidebarCollapsed, wideCollapsed)
    wideCollapsed = undefined
  })

  const toggleFavoriteModel = (key: string) => {
    setFavorites((current) => {
      const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
      writeStorage(STORAGE_KEYS.favoriteModels, next)
      return next
    })
  }

  const toggleSidebar = () => {
    const next = !collapsed()
    setCollapsed(next)
    writeStorage(STORAGE_KEYS.sidebarCollapsed, next)
  }

  // Whether the current stretch of work has already been offered, and whether the panel is open
  // because of it rather than because the reader opened it.
  let offeredForWork = false
  let openedForWork = false

  const toggleContextPanel = () => {
    const next = !contextHidden()
    setContextHidden(next)
    writeStorage(STORAGE_KEYS.contextPanelHidden, next)
    // The reader has taken over: from here the panel is theirs, not the work's to close later.
    openedForWork = false
  }
  const contextPanelShown = () => !!app.sessions.selectedSession() && !contextHidden()

  /**
   * The panel is for watching work, so it comes and goes with it: open while there is a task left
   * to do or one of this session's children is being worked on or waiting on a permission, closed
   * when there is nothing to watch.
   *
   * It offers itself once per stretch. A reader who closes it is not fought until the work stops
   * and starts again, and a stretch the reader opened through is left open when it ends.
   */
  createEffect(() => {
    const sessionID = app.sessions.selected()
    // The session's own context is still loading while the resources hold the last session's
    // value: deciding now would offer the panel for work that belongs to the session left behind,
    // which is the flash of it a reader sees right after switching.
    if (sessionID && app.sessions.children()?.sessionID !== sessionID) return
    const work = (app.sessions.subagents() ?? []).some(
      (child) => !!app.sessions.runState()[child.id] || app.sessions.blockedSessions().includes(child.id),
    )
    if (work) {
      if (offeredForWork) return
      offeredForWork = true
      if (!contextHidden()) return
      openedForWork = true
      setContextHidden(false)
      return
    }
    offeredForWork = false
    if (!openedForWork) return
    openedForWork = false
    setContextHidden(true)
  })
  const updateContextWidth = (width: number) => {
    const next = Math.max(CONTEXT_PANEL_WIDTH.min, Math.min(CONTEXT_PANEL_WIDTH.max, Math.round(width)))
    setContextWidth(next)
    writeStorage(STORAGE_KEYS.contextPanelWidth, next)
  }

  const updateSidebarWidth = (width: number) => {
    const next = Math.max(200, Math.min(480, Math.round(width)))
    setSidebarWidth(next)
    writeStorage(STORAGE_KEYS.sidebarWidth, next)
  }

  const togglePanel = (kind: string) => {
    const next = panels().includes(kind) ? panels().filter((value) => value !== kind) : [...panels(), kind]
    setPanels(next)
    writeStorage(STORAGE_KEYS.workspacePanels, next)
  }

  const closePanel = (kind: string) => {
    const next = panels().filter((value) => value !== kind)
    setPanels(next)
    writeStorage(STORAGE_KEYS.workspacePanels, next)
  }

  const updateWorkspaceWidth = (width: number) => {
    const next = Math.max(280, Math.min(900, Math.round(width)))
    setWorkspaceWidth(next)
    writeStorage(STORAGE_KEYS.workspaceWidth, next)
  }

  const updateDisplayName = (value: string) => {
    setDisplayName(value)
    writeStorage(STORAGE_KEYS.displayName, value)
  }

  const completeOnboarding = (name: string) => {
    if (name.trim()) updateDisplayName(name.trim())
    setOnboarded(true)
    writeStorage(STORAGE_KEYS.onboarded, true)
  }

  const updateTheme = (value: string) => {
    setTheme(value)
    writeStorage(STORAGE_KEYS.theme, value)
  }

  const updateColorTheme = (value: string) => {
    setColorTheme(value)
    writeStorage(STORAGE_KEYS.colorTheme, value)
  }

  createEffect(() => {
    const mode = theme()
    const palette = colorTheme()
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const apply = () => {
      const dark = mode === "dark" || (mode === "system" && media.matches)
      const root = document.documentElement
      root.classList.toggle("fc-dark", dark)
      // The palette rides alongside the mode class, so it also survives a System mode change.
      // The default palette needs no attribute: it is what `:root` already declares.
      if (palette === "flupcode") delete root.dataset.fcTheme
      else root.dataset.fcTheme = palette
      // The index.html bootstrap paints this before the stylesheet loads, which is the only moment
      // the inline value is needed: `html { background-color: var(--fc-bg) }` takes over from here.
      root.style.backgroundColor = ""
      // The browser and installed app paint their status bar with this colour.
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", getComputedStyle(root).backgroundColor)
    }
    apply()
    media.addEventListener("change", apply)
    onCleanup(() => media.removeEventListener("change", apply))
  })

  const toggleNotifications = () => {
    const next = !notifications()
    if (next && typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission()
    }
    setNotifications(next)
    writeStorage(STORAGE_KEYS.notifications, next)
  }

  const changeKeybind = (action: KeybindAction, binding: string) => {
    const next = withKeybind(keybinds(), action, binding)
    setKeybinds(next)
    writeStorage(STORAGE_KEYS.keybinds, next)
  }
  return {
    changeKeybind,
    closePanel,
    collapsed,
    colorTheme,
    completeOnboarding,
    contextHidden,
    contextPanelShown,
    contextWidth,
    desktopWindow,
    displayName,
    favorites,
    keybinds,
    mcpAuthNoticeDismissed,
    mobileRemote,
    narrow,
    notifications,
    onboarded,
    panels,
    sessionTabsEnabled,
    setCollapsed,
    setMcpAuthNoticeDismissed,
    setOnboarded,
    setPanels,
    showReasoning,
    showTools,
    sidebarWidth,
    theme,
    toggleContextPanel,
    toggleFavoriteModel,
    toggleNotifications,
    togglePanel,
    toggleReasoning,
    toggleSessionTabs,
    toggleSidebar,
    toggleTools,
    updateColorTheme,
    updateContextWidth,
    updateDisplayName,
    updateSidebarWidth,
    updateTheme,
    updateWorkspaceWidth,
    workspaceWidth,
  }
}

export type SettingsStore = ReturnType<typeof createSettings>
