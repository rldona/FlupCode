import { posix, win32 } from "node:path"

/**
 * The editors a page may open a file in (H-14), keyed by the names the renderer sends (`editorApp`
 * in harness/src/remote.ts): VS Code's bundle name on macOS, its `code` command elsewhere. The
 * command each one runs is decided here, never by the page, so a compromised renderer cannot name a
 * binary of its own (TI-17).
 */
const EDITORS = new Map([
  ["Visual Studio Code", { bundle: "Visual Studio Code", command: "code" }],
  ["code", { bundle: "Visual Studio Code", command: "code" }],
])

/** `cmd /c` parses its arguments again: any of these in a path would start a command of its own. */
const CMD_METACHARACTERS = /["%&<>^|]/

/**
 * The command that opens `path` in the editor `app` names, or undefined when that editor is not on
 * the list or the path is not a plain absolute one.
 *
 * macOS has `open -a <bundle>`, Windows resolves `code` (a `.cmd`) through the `cmd` shell, and
 * Linux runs the command directly.
 */
export function editorCommand(platform: NodeJS.Platform, app: string, path: string) {
  const editor = EDITORS.get(app)
  if (!editor || !plainAbsolutePath(platform, path)) return undefined
  if (platform === "darwin") return { command: "open", args: ["-a", editor.bundle, path] }
  if (platform === "win32") return { command: "cmd", args: ["/c", editor.command, path] }
  return { command: editor.command, args: [path] }
}

// Absolute, so it can never be read as a flag; one line, and free of what `cmd` would act on.
function plainAbsolutePath(platform: NodeJS.Platform, path: string) {
  if (/[\r\n\0]/.test(path)) return false
  if (platform === "win32") return win32.isAbsolute(path) && !CMD_METACHARACTERS.test(path)
  return posix.isAbsolute(path)
}
