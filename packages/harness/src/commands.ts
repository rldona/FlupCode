import { UNAVAILABLE_FEATURES } from "./features"
import { t } from "./i18n"
import { DESTINATIONS, type DestinationId } from "./navigation"

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
  /** Opens a destination (UX-01), the same way the sidebar and the search do. */
  go: (id: DestinationId) => void
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
  // A destination with a `/name` opens under the same name as everywhere else (UX-01).
  ...DESTINATIONS.flatMap((entry): BuiltinCommand[] =>
    entry.command
      ? [
          {
            id: entry.command,
            title: entry.title,
            group: "Go to",
            desktop: entry.desktop,
            // `/actions` with text after it is the reader asking for an action to run, so the text goes
            // to the agent, which owns the tool and its approval. Alone, it opens the screen.
            run: (context, args) => (entry.id === "actions" && args ? context.send(args) : context.go(entry.id)),
          },
        ]
      : [],
  ),
  { id: "steps", title: "Show or hide tool steps", group: "App", run: (context) => context.toggleSteps() },
  { id: "toggle-sidebar", title: "Toggle sidebar", group: "App", run: (context) => context.toggleSidebar() },
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
