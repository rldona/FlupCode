import { describe, expect, test } from "bun:test"
import { editorCommand } from "./open-path"

describe("opening a file in a named editor (TI-17)", () => {
  test("the editor the renderer names resolves to a fixed command on each platform", () => {
    expect(editorCommand("darwin", "Visual Studio Code", "/work/a.md")).toEqual({
      command: "open",
      args: ["-a", "Visual Studio Code", "/work/a.md"],
    })
    expect(editorCommand("win32", "code", "C:\\work\\a.md")).toEqual({
      command: "cmd",
      args: ["/c", "code", "C:\\work\\a.md"],
    })
    expect(editorCommand("linux", "code", "/work/a.md")).toEqual({ command: "code", args: ["/work/a.md"] })
    // Either name means the same editor: the renderer picks one by platform, main decides the command.
    expect(editorCommand("darwin", "code", "/work/a.md")?.args).toEqual(["-a", "Visual Studio Code", "/work/a.md"])
    expect(editorCommand("linux", "Visual Studio Code", "/work/a.md")?.command).toBe("code")
  })

  test("an application the list does not name is refused, whatever the platform", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(editorCommand(platform, "/usr/bin/touch", "/work/a.md")).toBeUndefined()
      expect(editorCommand(platform, "Terminal", "/work/a.md")).toBeUndefined()
      expect(editorCommand(platform, "calc.exe", "C:\\work\\a.md")).toBeUndefined()
      expect(editorCommand(platform, "constructor", "/work/a.md")).toBeUndefined()
      expect(editorCommand(platform, "", "/work/a.md")).toBeUndefined()
    }
  })

  test("a path that could be read as an option or a second command is refused", () => {
    // Relative paths would resolve against the app's own directory, and `-x` reads as a flag.
    expect(editorCommand("linux", "code", "-r")).toBeUndefined()
    expect(editorCommand("darwin", "code", "--args")).toBeUndefined()
    expect(editorCommand("linux", "code", "a.md")).toBeUndefined()
    expect(editorCommand("win32", "code", "a.md")).toBeUndefined()
    // `cmd /c` parses the path again: a metacharacter in it would start a command of its own.
    expect(editorCommand("win32", "code", "C:\\work\\a.md & calc.exe")).toBeUndefined()
    expect(editorCommand("win32", "code", "C:\\work\\%PATH%.md")).toBeUndefined()
    expect(editorCommand("win32", "code", 'C:\\work\\a.md" | calc')).toBeUndefined()
    expect(editorCommand("linux", "code", "/work/a.md\nrm")).toBeUndefined()
    // Those characters are only special to cmd: a POSIX file may well be called that.
    expect(editorCommand("linux", "code", "/work/R&D notes.md")?.args).toEqual(["/work/R&D notes.md"])
  })
})
