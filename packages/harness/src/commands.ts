import { UNAVAILABLE_FEATURES } from "./features"
import { t } from "./i18n"
import type { Screen } from "./screen"

/**
 * The app's own `/` commands, in one place for the palette and the composer (TI-13).
 *
 * They were two if-ladders, and they had drifted: `/files` or `/providers` typed in the composer was
 * sent to the engine as an unknown command, creating a session first. Both entry points now ask
 * `runBuiltin` before anything else, and only a name it does not know goes on to the engine.
 * The engine's commands, skills and workflows are not here: they belong to the project.
 */

/** What a built-in can do to the app. The app builds one per run; a test builds a fake. */
export type CommandContext = {
  /** The open session, if there is one. */
  session: string | undefined
  /** The composer's draft, which `/stash` from the palette saves. */
  draft: string
  notify: (message: string) => void
  newSession: () => void
  showScreen: (screen: Screen) => void
  openSettings: (section: "mcp" | "providers") => void
  open: (dialog: "about" | "settings" | "stashes" | "remote" | "skills" | "best-of-n" | "memory" | "config") => void
  /** Sends text as a message, through whatever the open view sends with. */
  send: (text: string) => void
  stash: (text: string) => void
  compact: () => void
  resume: () => void
  skillify: () => void
  toggleSteps: () => void
  toggleSidebar: () => void
  cycleTab: (delta: 1 | -1) => void
  closeTab: (session: string) => void
  split: (session: string) => void
  rename: (session: string) => void
  pin: (session: string) => void
  remove: (session: string) => void
}

/** The headings of the `/` menu, in the order it shows them. */
export const COMMAND_GROUPS = ["Session", "Go to", "App"] as const

export type BuiltinCommand = {
  id: string
  /** An i18n key. */
  title: string
  group: (typeof COMMAND_GROUPS)[number]
  /** Acts on the open session, so it is not offered, and does not run, without one. */
  session?: boolean
  /** Offered in the desktop app only. */
  desktop?: boolean
  /** Other names that run it. */
  aliases?: string[]
  /** `args` is what was typed after the name; the palette passes none. */
  run: (context: CommandContext, args: string) => void
}

/** Listed in menu order: grouped, and within a group the most used first. */
export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { id: "new", title: "New session…", group: "Session", aliases: ["clear"], run: (context) => context.newSession() },
  {
    id: "compact",
    title: "Compact the current session",
    group: "Session",
    session: true,
    run: (context) => context.compact(),
  },
  {
    id: "resume",
    title: "Checkpoint of this session",
    group: "Session",
    session: true,
    run: (context) => context.resume(),
  },
  {
    id: "skillify",
    title: "Save this session as a skill",
    group: "Session",
    session: true,
    run: (context) => context.skillify(),
  },
  {
    id: "stash",
    title: "Save the current prompt",
    group: "Session",
    // Typed, it saves what follows it; from the palette, the draft.
    run: (context, args) => context.stash(args || context.draft),
  },
  { id: "stashes", title: "View saved prompts", group: "Session", run: (context) => context.open("stashes") },
  {
    id: "rename",
    title: "Rename session",
    group: "Session",
    session: true,
    run: (context) => context.rename(context.session!),
  },
  {
    id: "pin",
    title: "Pin or unpin this session",
    group: "Session",
    session: true,
    run: (context) => context.pin(context.session!),
  },
  {
    id: "split",
    title: "Split view",
    group: "Session",
    session: true,
    run: (context) => context.split(context.session!),
  },
  {
    id: "delete",
    title: "Delete this session",
    group: "Session",
    session: true,
    run: (context) => context.remove(context.session!),
  },
  { id: "next-tab", title: "Next session tab", group: "Session", run: (context) => context.cycleTab(1) },
  { id: "prev-tab", title: "Previous session tab", group: "Session", run: (context) => context.cycleTab(-1) },
  {
    id: "close-tab",
    title: "Close this session tab",
    group: "Session",
    session: true,
    run: (context) => context.closeTab(context.session!),
  },
  { id: "files", title: "Files", group: "Go to", run: (context) => context.showScreen("files") },
  { id: "artifacts", title: "Artifacts", group: "Go to", run: (context) => context.showScreen("artifacts") },
  { id: "skills", title: "Skills", group: "Go to", run: (context) => context.open("skills") },
  { id: "workflows", title: "Workflows", group: "Go to", run: (context) => context.showScreen("workflows") },
  { id: "routines", title: "Scheduled tasks", group: "Go to", run: (context) => context.showScreen("routines") },
  {
    id: "actions",
    title: "Web actions",
    group: "Go to",
    desktop: true,
    // With nothing after it, the screen. With text, the reader is asking for an action to run, so the
    // text goes to the agent, which owns the tool and its approval.
    run: (context, args) => (args ? context.send(args) : context.showScreen("actions")),
  },
  { id: "compare", title: "Compare two runs", group: "Go to", run: (context) => context.showScreen("compare") },
  {
    id: "best-of-n",
    title: "Best of N: one task, several models",
    group: "Go to",
    run: (context) => context.open("best-of-n"),
  },
  { id: "memory", title: "Memory", group: "Go to", run: (context) => context.open("memory") },
  { id: "steps", title: "Show or hide tool steps", group: "App", run: (context) => context.toggleSteps() },
  { id: "toggle-sidebar", title: "Toggle sidebar", group: "App", run: (context) => context.toggleSidebar() },
  { id: "settings", title: "Customize FlupCode", group: "App", run: (context) => context.open("settings") },
  { id: "providers", title: "Providers & API keys", group: "App", run: (context) => context.openSettings("providers") },
  { id: "mcp", title: "MCP servers…", group: "App", run: (context) => context.openSettings("mcp") },
  { id: "config", title: "Config (advanced)", group: "App", run: (context) => context.open("config") },
  { id: "remote", title: "Remote control / mobile", group: "App", run: (context) => context.open("remote") },
  { id: "about", title: "About FlupCode", group: "App", run: (context) => context.open("about") },
]

export function builtinCommand(name: string) {
  return BUILTIN_COMMANDS.find((command) => command.id === name || command.aliases?.includes(name))
}

/**
 * Runs `name` when it is a built-in and says whether it was: `false` means the caller hands it on to
 * the engine. A built-in that cannot run here still counts as handled, so it never reaches the engine.
 */
export function runBuiltin(name: string, args: string, context: CommandContext) {
  const command = builtinCommand(name)
  if (!command) return false
  if (UNAVAILABLE_FEATURES.has(command.id)) {
    context.notify(t("Coming soon"))
    return true
  }
  if (command.session && !context.session) {
    context.notify(t("No session"))
    return true
  }
  command.run(context, args)
  return true
}
