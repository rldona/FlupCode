import { describe, expect, test } from "bun:test"
import { DEFAULT_TOOL_TRIM_CONFIG } from "./config"
import { evidenceRange, trimSkip, trimmedOutput } from "./tool-trim"

const REF = "0123456789abcdef"
const ON = { ...DEFAULT_TOOL_TRIM_CONFIG, enabled: true, thresholdBytes: 4_096, headBytes: 200, tailBytes: 200, readBytes: 1_000 }

const numbered = (count: number, width = 40) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1} `.padEnd(width, "x")).join("\n") + "\n"

describe("trimSkip", () => {
  test("trims only an enabled, non-exempt output between the threshold and the store cap", () => {
    expect(trimSkip({ ...ON, enabled: false }, "bash", 10_000)).toBe("disabled")
    expect(trimSkip(ON, "read", 10_000)).toBe("exempt")
    expect(trimSkip(ON, "bash", 4_096)).toBe("below-threshold")
    expect(trimSkip(ON, "bash", ON.maxStoredBytes + 1)).toBe("too-large")
    expect(trimSkip(ON, "bash", 4_097)).toBeUndefined()
  })

  test("the recovery tool is exempt even when the config exempts nothing", () => {
    expect(trimSkip({ ...ON, exempt: [] }, "evidence_read", 10_000)).toBe("exempt")
  })
})

describe("trimmedOutput", () => {
  test("names the ref, the range syntax, the head and tail lines and what was omitted", () => {
    const content = numbered(500)
    const text = trimmedOutput(content, REF, ON)
    expect(text).toContain(`evidence:${REF}`)
    expect(text).toContain(`call evidence_read with ref "${REF}" and range "START-END"`)
    expect(text).toContain("at most 1000 bytes")
    expect(text).toContain(`${Buffer.byteLength(content)} bytes, 500 lines`)
    expect(text).toContain("--- head (lines 1-4) ---")
    expect(text).toContain("line 1 ")
    expect(text).toContain("--- lines 5-496 omitted ---")
    expect(text).toContain("--- tail (lines 497-500) ---")
    expect(text).toContain("line 500 ")
    expect(text).not.toContain("line 250 ")
    expect(text.length).toBeLessThan(content.length / 4)
  })

  test("describes a JSON output by its top level", () => {
    const array = JSON.stringify(Array.from({ length: 300 }, (_, index) => ({ id: index, name: `item-${index}` })))
    expect(trimmedOutput(array, REF, ON)).toContain("Structure: a JSON array of 300 item(s).")
    const object = JSON.stringify({ alpha: "x".repeat(5_000), beta: 1 })
    expect(trimmedOutput(object, REF, ON)).toContain("Structure: a JSON object with 2 key(s): alpha, beta.")
  })

  test("points at the lines that report trouble", () => {
    const content = numbered(200).replace("line 120 ", "line 120 ERROR: boom ").replace("line 180 ", "line 180 warning ")
    expect(trimmedOutput(content, REF, ON)).toContain("2 line(s) mention an error, failure or warning (first at line 120, last at line 180)")
  })

  test("falls back to byte offsets when one line is longer than the head or tail", () => {
    const content = "é".repeat(5_000)
    const text = trimmedOutput(content, REF, ON)
    expect(text).toContain("--- head (bytes 0-200) ---")
    expect(text).toContain("--- tail (bytes 9800-10000) ---")
    expect(text).toContain("--- middle omitted ---")
    // No character is split at a cut.
    expect(text).not.toContain("�")
  })
})

describe("evidenceRange", () => {
  const content = numbered(100)

  test("reads inclusive 1-based lines and says what it returned", () => {
    const text = evidenceRange(content, REF, "10-12", 1_000)
    expect(text.split("\n")[0]).toBe(`[evidence:${REF} lines 10-12 of 100]`)
    expect(text).toContain("line 10 ")
    expect(text).toContain("line 12 ")
    expect(text).not.toContain("line 13 ")
    expect(text).not.toContain("[more:")
  })

  test("stops at the read budget and names the next range", () => {
    const text = evidenceRange(content, REF, "1-100", 1_000)
    expect(text.split("\n")[0]).toBe(`[evidence:${REF} lines 1-24 of 100]`)
    expect(text).toContain(`[more: call evidence_read with range "25-100"]`)
  })

  test("an empty range, a single line and an open range start where they say", () => {
    expect(evidenceRange(content, REF, "", 1_000).split("\n")[0]).toBe(`[evidence:${REF} lines 1-24 of 100]`)
    expect(evidenceRange(content, REF, "all", 1_000).split("\n")[0]).toBe(`[evidence:${REF} lines 1-24 of 100]`)
    expect(evidenceRange(content, REF, "90", 1_000).split("\n")[0]).toBe(`[evidence:${REF} lines 90-100 of 100]`)
    expect(evidenceRange(content, REF, "90-", 1_000).split("\n")[0]).toBe(`[evidence:${REF} lines 90-100 of 100]`)
  })

  test("reads byte offsets and continues from where it stopped", () => {
    const text = evidenceRange(content, REF, "bytes:0-", 100)
    expect(text.split("\n")[0]).toBe(`[evidence:${REF} bytes 0-100 of ${Buffer.byteLength(content)}]`)
    expect(text).toContain(`[more: call evidence_read with range "bytes:100-${Buffer.byteLength(content)}"]`)
  })

  test("reading every range in turn reconstructs the output exactly", () => {
    const original = numbered(300) + "tail without newline é"
    const pieces: string[] = []
    let range = "bytes:0-"
    for (let guard = 0; guard < 100 && range; guard++) {
      const text = evidenceRange(original, REF, range, 777)
      const [header, ...rest] = text.split("\n")
      const next = /\[more: call evidence_read with range "([^"]+)"\]$/.exec(text)
      const body = rest.join("\n")
      pieces.push(next ? body.slice(0, body.lastIndexOf("\n[more:")) : body)
      expect(header).toMatch(/^\[evidence:0123456789abcdef bytes \d+-\d+ of \d+\]$/)
      range = next ? next[1]! : ""
    }
    expect(pieces.join("")).toBe(original)
  })

  test("a line longer than a read is continued by byte offsets", () => {
    const long = "short\n" + "y".repeat(3_000) + "\nend\n"
    const text = evidenceRange(long, REF, "2", 1_000)
    expect(text.split("\n")[0]).toBe(`[evidence:${REF} bytes 6-1006 of ${Buffer.byteLength(long)}]`)
    expect(text).toContain(`[more: call evidence_read with range "bytes:1006-3006"]`)
  })

  test("an unreadable or out-of-range request is an answer the model can correct", () => {
    expect(evidenceRange(content, REF, "lines ten", 1_000)).toContain('Unreadable range "lines ten"')
    expect(evidenceRange(content, REF, "500-600", 1_000)).toContain("Line 500 is outside the output, which has lines 1-100")
    expect(evidenceRange(content, REF, "20-10", 1_000)).toContain("ends before it starts")
    expect(evidenceRange(content, REF, "bytes:999999-", 1_000)).toContain("is outside the output")
  })
})
