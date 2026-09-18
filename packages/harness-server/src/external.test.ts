import { describe, expect, test } from "bun:test"
import { externalCommand, runExternal, shellQuote } from "./external"

describe("an external command (H-38)", () => {
  test("quotes a prompt as one shell word, whatever is in it", () => {
    expect(shellQuote("hello")).toBe("'hello'")
    expect(shellQuote("don't stop")).toBe("'don'\\''t stop'")
    expect(shellQuote("two\nlines")).toBe("'two\nlines'")
    expect(shellQuote("")).toBe("''")
  })

  test("puts the prompt where {{prompt}} is, and nowhere else", () => {
    expect(externalCommand("codex exec {{prompt}}", "do it")).toBe("codex exec 'do it'")
    expect(externalCommand("first {{ prompt }} then {{prompt}}", "x")).toBe("first 'x' then 'x'")
    // A command that does not ask for it runs without it: appending would be inventing a convention.
    expect(externalCommand("bun run check", "ignored")).toBe("bun run check")
  })

  test("a prompt with an apostrophe reaches the command whole", async () => {
    // The same path the runner takes, with the quoting it relies on.
    const result = await runExternal({
      command: externalCommand("printf %s {{prompt}}", "don't stop"),
      directory: process.cwd(),
    })
    expect(result.ok).toBe(true)
    expect(result.output).toBe("don't stop")
  })

  test("an exit that is not zero is the command saying no", async () => {
    const result = await runExternal({ command: "echo broken >&2; exit 3", directory: process.cwd() })
    expect(result).toMatchObject({ ok: false, exitCode: 3, stopped: false, timedOut: false })
    expect(result.output).toContain("broken")
  })

  test("a run that is stopped kills the process and says so", async () => {
    const startedAt = Date.now()
    let stop = false
    setTimeout(() => {
      stop = true
    }, 100)
    // The command is still going when the stop arrives; it is killed, not waited out.
    const result = await runExternal({ command: "sleep 30", directory: process.cwd(), stopped: () => stop, pollMs: 10 })
    expect(result.stopped).toBe(true)
    expect(result.ok).toBe(false)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  test("a declared ceiling kills the process and says why", async () => {
    const result = await runExternal({
      command: "sleep 30",
      directory: process.cwd(),
      limitMs: 50,
      pollMs: 10,
    })
    expect(result.timedOut).toBe(true)
    expect(result.ok).toBe(false)
  })

  test("what it prints is kept in full until the cap, and the tail after", async () => {
    const seen: string[] = []
    const result = await runExternal({
      command: "echo one; sleep 0.1; echo two",
      directory: process.cwd(),
      onOutput: (output) => seen.push(output),
    })
    expect(result.output).toContain("one")
    expect(result.output).toContain("two")
    // While it runs, the activity endpoint gets what has been printed so far.
    expect(seen.at(-1)).toContain("two")
  })
})
