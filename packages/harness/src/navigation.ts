import type { KeybindAction } from "./keybinds"

/**
 * Every place the app can take the reader, in one list (UX-01).
 *
 * The sidebar, the profile menu, the search, the `/` commands, the address bar and the shortcuts all
 * read this list, so a destination has one name and one way to open it wherever it is offered. Before
 * it there were five lists, and they had drifted: Settings was also "Customize", Routines also
 * "Scheduled tasks", Agents a screen and a Settings section, Skills a screen and a picker.
 *
 * `home` is where the reader finds it without searching:
 * - `sidebar`: the work itself, the primitives a session turns into.
 * - `menu`: the profile menu, for what explains or extends that work.
 * - `settings`: a section of Settings, which holds configuration and nothing else.
 * - `advanced`: a dialog opened from Settings › Advanced.
 * - `inline`: opened from where it applies (a run, a session, the composer), and from the search.
 */
export type Home = "sidebar" | "menu" | "settings" | "advanced" | "inline"

/** The sections of Settings, grouped the way its rail shows them. Labels are i18n keys. */
export const SETTINGS_GROUPS = [
  {
    label: "General",
    items: [
      { id: "appearance", label: "Appearance" },
      { id: "profile", label: "Profile" },
    ],
  },
  {
    label: "Models",
    items: [
      { id: "model", label: "Model" },
      { id: "providers", label: "Providers", command: "providers" },
    ],
  },
  {
    label: "Interface",
    items: [
      { id: "conversation", label: "Conversation" },
      { id: "notifications", label: "Notifications" },
      { id: "shortcuts", label: "Shortcuts" },
    ],
  },
  {
    label: "Automation",
    items: [
      { id: "permissions", label: "Permissions" },
      { id: "commands", label: "Commands" },
      { id: "agents", label: "Agents" },
      { id: "mcp", label: "MCP servers", command: "mcp" },
    ],
  },
  {
    label: "Adaptive",
    items: [{ id: "adaptive", label: "Adaptive" }],
  },
  {
    label: "System",
    items: [
      { id: "server", label: "Server" },
      { id: "advanced", label: "Advanced" },
    ],
  },
] as const

export type SettingsSection = (typeof SETTINGS_GROUPS)[number]["items"][number]["id"]

/**
 * The destinations that are not a Settings section, in the order the sidebar and the menu show them.
 *
 * `command` is the `/name` that opens it from the composer; one without it is reached from the search
 * and its own home. A built-in shadows a project command of the same name, so new destinations do
 * not take a name lightly.
 */
const PLACES = [
  // The sidebar: the work primitives (Sessions are the list under them).
  { id: "runs", title: "Runs", home: "sidebar", screen: "runs" },
  { id: "workflows", title: "Workflows", home: "sidebar", screen: "workflows", command: "workflows" },
  { id: "routines", title: "Routines", home: "sidebar", screen: "routines", command: "routines" },
  { id: "artifacts", title: "Artifacts", home: "sidebar", screen: "artifacts", command: "artifacts" },
  { id: "cost", title: "Cost", home: "sidebar", screen: "cost" },
  // The profile menu.
  { id: "settings", title: "Settings", home: "menu", dialog: "settings", command: "settings", keybind: "settings" },
  { id: "skills", title: "Skills", home: "menu", screen: "skills", command: "skills" },
  // The web action profiles (WA-8), which only the desktop app can run.
  { id: "actions", title: "Actions", home: "menu", screen: "actions", command: "actions", desktop: true },
  { id: "context", title: "Context", home: "menu", screen: "context" },
  { id: "decisions", title: "Decisions", home: "menu", screen: "decisions" },
  { id: "memory", title: "Memory", home: "menu", dialog: "memory", command: "memory" },
  { id: "remote", title: "Remote control", home: "menu", dialog: "remote", command: "remote" },
  { id: "about", title: "About FlupCode", home: "menu", dialog: "about", command: "about" },
  // Opened from where they apply.
  { id: "changes", title: "Changes", home: "inline", screen: "changes" },
  { id: "files", title: "Files", home: "inline", screen: "files", command: "files" },
  { id: "compare", title: "Compare", home: "inline", screen: "compare", command: "compare" },
  { id: "best-of-n", title: "Best of N", home: "inline", dialog: "best-of-n", command: "best-of-n" },
  { id: "stashes", title: "Saved prompts", home: "inline", dialog: "stashes", command: "stashes" },
  // Settings › Advanced.
  { id: "config", title: "Config (advanced)", home: "advanced", dialog: "config", command: "config" },
  { id: "config-files", title: "Config files", home: "advanced", dialog: "config-files" },
] as const

type Place = (typeof PLACES)[number]

/** A full screen, written in the path (see screen.ts). */
export type Screen = Extract<Place, { screen: string }>["screen"]

/**
 * The dialogs that are not destinations but still open from a link: the search itself, and the
 * pickers that act on the composer (its model, its folder), which have nothing to show on their own.
 */
export const PICKERS = ["palette", "model", "folder"] as const

/** A dialog that opens without a target, from a link as `?dialog=<name>` (UX-00). */
export type Dialog = Extract<Place, { dialog: string }>["dialog"] | (typeof PICKERS)[number]

export type DestinationId = Place["id"] | `settings-${SettingsSection}`

export type Destination = {
  id: DestinationId
  /** An i18n key: the one name it has everywhere. */
  title: string
  home: Home
  screen?: Screen
  dialog?: Dialog
  /** The Settings section it opens on; only with the `settings` dialog. */
  section?: SettingsSection
  /** The Settings group it is listed under, for a section. */
  group?: string
  command?: string
  /** Offered in the desktop app only. */
  desktop?: boolean
  /** The editable shortcut that opens it. */
  keybind?: KeybindAction
}

export const DESTINATIONS: Destination[] = [
  ...PLACES,
  ...SETTINGS_GROUPS.flatMap((group) =>
    group.items.map(
      (item): Destination => ({
        id: `settings-${item.id}`,
        title: item.label,
        home: "settings",
        dialog: "settings",
        section: item.id,
        group: group.label,
        command: "command" in item ? item.command : undefined,
      }),
    ),
  ),
]

export function destination(id: DestinationId) {
  return DESTINATIONS.find((entry) => entry.id === id)
}

/** The screens, in the order of the list. */
export const SCREENS = DESTINATIONS.flatMap((entry) => (entry.screen ? [entry.screen] : []))

/**
 * Addresses from before UX-01, and the destination each one leads to now, so a bookmark, a link in
 * a note or a hand that types `/usage` still lands. They are rewritten in the address bar on arrival.
 */
export const MOVED_PATHS: Record<string, DestinationId> = {
  // The screen was always titled Cost; its address now says so too.
  usage: "cost",
  // The agents screen and the Settings section were the same editor; the section stays.
  agents: "settings-agents",
}

/** `?dialog=` names from before UX-01: the skill picker gave way to the Skills screen. */
export const MOVED_DIALOGS: Record<string, DestinationId> = {
  skills: "skills",
}

/** Where a destination lives: a path for a screen, a `?dialog=` link for a dialog. */
export function urlForDestination(entry: Destination) {
  if (entry.screen) return `/${entry.screen}`
  const params = new URLSearchParams({ dialog: entry.dialog ?? "" })
  if (entry.section) params.set("section", entry.section)
  return `/?${params}`
}

/** Destinations this build offers: the desktop-only ones are left out of the browser build. */
export function offered(desktop: boolean) {
  return DESTINATIONS.filter((entry) => desktop || !entry.desktop)
}
