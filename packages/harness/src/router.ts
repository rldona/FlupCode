import { createEffect, createSignal, onCleanup } from "solid-js"
import {
  compareFromSearch,
  decisionFromSearch,
  screenFromPath,
  searchForDecision,
  urlForScreen,
  type Screen,
} from "./screen"
import { isBrowsableUrl, isExternalLinkAllowed, openExternalUrl } from "./external-links"
import type { SettingsSection } from "./components/SettingsPanel"
import type { AppStores } from "./app-context"

/**
 * The app's routes (UX-00): the screens, written in the path (see screen.ts), and the dialogs that
 * open over whatever screen is showing.
 *
 * A dialog is reached by a link as `?dialog=<name>`, Settings on a section as
 * `?dialog=settings&section=<section>`. The link is read when the page loads and when the browser
 * goes back or forward to it, and then taken out of the address, as the `?session=` launch link is:
 * a dialog closes without a trace in the history, as it always has.
 *
 * The dialogs that act on something the reader picked (rename, tags, a confirmation, an external
 * link, a model switch, a workflow's inputs) are not routes: without their target there is nothing
 * for them to show.
 */
export const DIALOGS = [
  "settings",
  "about",
  "stashes",
  "remote",
  "skills",
  "best-of-n",
  "memory",
  "config",
  "config-files",
  "palette",
  "model",
  "folder",
] as const

export type Dialog = (typeof DIALOGS)[number]

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  "appearance",
  "profile",
  "model",
  "providers",
  "conversation",
  "notifications",
  "shortcuts",
  "permissions",
  "commands",
  "agents",
  "mcp",
  "adaptive",
  "server",
  "advanced",
]

/** The dialog a link names, with the Settings section it opens on. Anything else names none. */
export function dialogFromSearch(search: string): { dialog: Dialog; section?: SettingsSection } | undefined {
  const params = new URLSearchParams(search)
  const dialog = DIALOGS.find((name) => name === params.get("dialog"))
  if (!dialog) return undefined
  const section = SETTINGS_SECTIONS.find((name) => name === params.get("section"))
  return dialog === "settings" && section ? { dialog, section } : { dialog }
}

/** Where a dialog lives: its link, beside the screen's own address. */
export function searchForDialog(dialog: Dialog, section?: SettingsSection) {
  return `?${new URLSearchParams({ dialog, ...(dialog === "settings" && section ? { section } : {}) })}`
}

/** The address without its dialog link, once the dialog it named is open. */
export function searchWithoutDialog(search: string) {
  const params = new URLSearchParams(search)
  params.delete("dialog")
  params.delete("section")
  const rest = params.toString()
  return rest ? `?${rest}` : ""
}

export function createRouter(app: AppStores) {
  // Which full screen is open, and where in the URL it lives, so a reload comes back to it and the
  // browser's Back leaves it. One signal rather than a flag per screen: only one can be open, and
  // two flags could disagree.
  const [screen, setScreen] = createSignal<Screen | undefined>(screenFromPath(window.location.pathname))
  // The pair a comparison link names (H-44). Kept beside the screen because both arrive in the same
  // address: a best-of-n lands on /compare?left=…&right=…, and a reload comes back to the same pair.
  const [compareArgs, setCompareArgs] = createSignal(compareFromSearch(window.location.search))
  // The decision the audit opens on (AH-E05); a link to it is `showScreen("decisions", searchForDecision(id))`.
  const [decisionFocus, setDecisionFocus] = createSignal(decisionFromSearch(window.location.search))
  const showScreen = (next: Screen | undefined, search?: string) => {
    const same = screen() === next
    setScreen(next)
    if (same && search === undefined) return
    window.history.pushState(
      null,
      "",
      search === undefined
        ? urlForScreen(next, window.location)
        : urlForScreen(next, { search, hash: window.location.hash }),
    )
    setDecisionFocus(decisionFromSearch(window.location.search))
  }
  const routinesOpen = () => screen() === "routines"
  const runsOpen = () => screen() === "runs"
  const artifactsOpen = () => screen() === "artifacts"
  const filesOpen = () => screen() === "files"
  const changesOpen = () => screen() === "changes"
  const usageOpen = () => screen() === "usage"
  const contextOpen = () => screen() === "context"
  const decisionsOpen = () => screen() === "decisions"
  // The composer chip's "Why?" (AH-E02) links to the decision like the banner does.
  const showDecision = (decisionID: string) => showScreen("decisions", searchForDecision(decisionID))
  const agentsOpen = () => screen() === "agents"
  const skillsScreenOpen = () => screen() === "skills"
  const workflowsScreenOpen = () => screen() === "workflows"
  const actionsOpen = () => screen() === "actions"
  const compareOpen = () => screen() === "compare"
  /**
   * The tool screens that live in the main column (HF-9): runs, workflows, artifacts, changes,
   * routines, context, agents, skills and usage render where the conversation goes, with the
   * sidebar visible, instead of a fixed overlay. Anything else keeps its overlay.
   */
  const toolScreen = () => {
    const current = screen()
    return (
      current === "runs" ||
      current === "workflows" ||
      current === "changes" ||
      current === "artifacts" ||
      current === "routines" ||
      current === "actions" ||
      current === "context" ||
      current === "decisions" ||
      current === "agents" ||
      current === "skills" ||
      current === "usage" ||
      current === "compare"
    )
  }
  /** Leave whatever screen is open. Doing anything with a session means leaving it. */
  const leaveScreen = () => showScreen(undefined)
  createEffect(() => {
    const follow = () => {
      setScreen(screenFromPath(window.location.pathname))
      setCompareArgs(compareFromSearch(window.location.search))
      setDecisionFocus(decisionFromSearch(window.location.search))
      openLinkedDialog()
    }
    window.addEventListener("popstate", follow)
    onCleanup(() => window.removeEventListener("popstate", follow))
  })

  const [settingsOpen, setSettingsOpen] = createSignal(false)
  /** The settings section to show when the panel opens (CU-1). */
  const [settingsSection, setSettingsSection] = createSignal<SettingsSection | undefined>(undefined)
  /** Settings, opened on a section: agents and the rest live on one surface (F4-3). */
  const openSettings = (section?: SettingsSection) => {
    setSettingsSection(section)
    setSettingsOpen(true)
  }
  /** The agents section is showing: its files, tools and models load like a screen did. */
  const agentsSectionVisible = () => settingsOpen() && settingsSection() === "agents"
  /** The providers section is showing: its directory, methods and links load like a screen did. */
  const providersSectionVisible = () => settingsOpen() && settingsSection() === "providers"
  const [aboutOpen, setAboutOpen] = createSignal(false)
  const [stashOpen, setStashOpen] = createSignal(false)
  const [remoteOpen, setRemoteOpen] = createSignal(false)
  const [skillsOpen, setSkillsOpen] = createSignal(false)
  /**
   * One task, several models (H-44).
   *
   * Each model gets its own run, so the comparison the batch exists for is the screen H-33 already
   * built, opened with the first two runs already chosen. Worktrees are on by default there, because
   * N agents writing the same tree would be comparing a fight; the dialog can turn them off.
   */
  const [bestOfNOpen, setBestOfNOpen] = createSignal(false)
  const [memoryOpen, setMemoryOpen] = createSignal(false)
  const [configOpen, setConfigOpen] = createSignal(false)
  const [configFilesOpen, setConfigFilesOpen] = createSignal(false)
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false)
  const [folderOpen, setFolderOpen] = createSignal(false)
  // Exporting (H-35): markdown with options, or the raw JSON. The dialog holds the choices; this
  // builds the file.
  const [exportOpen, setExportOpen] = createSignal(false)

  /** Opens a dialog by its route name: from a link, a command or the palette. */
  const openDialog = (dialog: Dialog, section?: SettingsSection) => {
    if (dialog === "settings") return section ? openSettings(section) : setSettingsOpen(true)
    if (dialog === "about") return setAboutOpen(true)
    if (dialog === "stashes") return setStashOpen(true)
    if (dialog === "remote") return setRemoteOpen(true)
    if (dialog === "skills") return setSkillsOpen(true)
    if (dialog === "best-of-n") return setBestOfNOpen(true)
    if (dialog === "memory") return setMemoryOpen(true)
    if (dialog === "config") return setConfigOpen(true)
    if (dialog === "config-files") return setConfigFilesOpen(true)
    if (dialog === "palette") return setPaletteOpen(true)
    if (dialog === "model") return setModelPickerOpen(true)
    setFolderOpen(true)
  }
  /** Opens the dialog the address names, and takes the link out of it. */
  const openLinkedDialog = () => {
    const linked = dialogFromSearch(window.location.search)
    if (!linked) return
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + searchWithoutDialog(window.location.search) + window.location.hash,
    )
    openDialog(linked.dialog, linked.section)
  }

  /** The external link the reader clicked, waiting to be confirmed and opened in their browser. */
  const [externalLink, setExternalLink] = createSignal<string>()
  const [renameTarget, setRenameTarget] = createSignal<{ id: string; title: string }>()
  const [tagsTarget, setTagsTarget] = createSignal<{ id: string; title: string; tags: string[] }>()
  // What a destructive action asks before doing it (H-24), instead of `window.confirm`.
  const [confirmTarget, setConfirmTarget] = createSignal<{
    title: string
    message: string
    confirmLabel?: string
    onConfirm: () => void
  }>()

  // Escape and Tab behave the same in every dialog (H-24): Escape closes the topmost one, and Tab
  // stays inside it. Done once here, a dialog added later gets both without remembering to.
  createEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // The stand-in a closing dialog leaves behind (modal-motion) is a copy with the same role:
      // it must not answer for the dialog still underneath it.
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(
        (dialog) => !dialog.closest(".fc-modal-leaving") && dialog.offsetParent !== null,
      )
      const top = dialogs.at(-1)
      if (!top) return
      if (event.key === "Escape") {
        const close = top.querySelector<HTMLButtonElement>('button[aria-label="Close"], button[aria-label="Cerrar"]')
        event.preventDefault()
        close?.click()
        return
      }
      if (event.key !== "Tab") return
      const selector =
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      const focusable = Array.from(top.querySelectorAll<HTMLElement>(selector)).filter(
        (node) => node.offsetParent !== null,
      )
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) return
      const active = document.activeElement
      if (event.shiftKey && (active === first || !top.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !top.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", onKey, true)
    onCleanup(() => document.removeEventListener("keydown", onKey, true))
  })

  // An http(s) link in the transcript belongs to the reader's own browser: the integrated panel
  // cannot render another origin (sandboxed iframe, X-Frame-Options), and the system browser can.
  // Ask first — with a "don't ask again for this host" — unless the host was already allowed.
  // Modified clicks, relative paths, same-origin targets and non-http(s) schemes keep their own
  // behaviour, and phones never get the prompt.
  createEffect(() => {
    const handler = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      if (app.settings.mobileRemote()) return
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest("a")
      if (!(anchor instanceof HTMLAnchorElement)) return
      if (!anchor.closest(".fc-transcript")) return
      if (anchor.download) return
      const href = anchor.href
      if (!isBrowsableUrl(href)) return
      if (new URL(href).origin === window.location.origin) return
      event.preventDefault()
      if (isExternalLinkAllowed(href)) openExternalUrl(href)
      else setExternalLink(href)
    }
    document.addEventListener("click", handler)
    onCleanup(() => document.removeEventListener("click", handler))
  })

  return {
    screen,
    showScreen,
    leaveScreen,
    toolScreen,
    routinesOpen,
    runsOpen,
    artifactsOpen,
    filesOpen,
    changesOpen,
    usageOpen,
    contextOpen,
    decisionsOpen,
    agentsOpen,
    skillsScreenOpen,
    workflowsScreenOpen,
    actionsOpen,
    compareOpen,
    compareArgs,
    setCompareArgs,
    decisionFocus,
    showDecision,
    openDialog,
    openLinkedDialog,
    settingsOpen,
    setSettingsOpen,
    settingsSection,
    setSettingsSection,
    openSettings,
    agentsSectionVisible,
    providersSectionVisible,
    aboutOpen,
    setAboutOpen,
    stashOpen,
    setStashOpen,
    remoteOpen,
    setRemoteOpen,
    skillsOpen,
    setSkillsOpen,
    bestOfNOpen,
    setBestOfNOpen,
    memoryOpen,
    setMemoryOpen,
    configOpen,
    setConfigOpen,
    configFilesOpen,
    setConfigFilesOpen,
    paletteOpen,
    setPaletteOpen,
    modelPickerOpen,
    setModelPickerOpen,
    folderOpen,
    setFolderOpen,
    exportOpen,
    setExportOpen,
    externalLink,
    setExternalLink,
    renameTarget,
    setRenameTarget,
    tagsTarget,
    setTagsTarget,
    confirmTarget,
    setConfirmTarget,
  }
}

export type RouterStore = ReturnType<typeof createRouter>
