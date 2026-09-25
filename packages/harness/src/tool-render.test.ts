import { describe, expect, test } from "bun:test"
import { actionLink, outputLines, parseActionSummary, parseTodos, taskSessionID } from "./tool-render"

describe("parseTodos", () => {
  test("reads the todo list the tool was given, keeping its order and statuses", () => {
    expect(
      parseTodos({
        todos: [
          { content: "write the test", status: "completed" },
          { content: "make it pass", status: "in_progress" },
          { content: "ship it" },
        ],
      }),
    ).toEqual([
      { content: "write the test", status: "completed" },
      { content: "make it pass", status: "in_progress" },
      { content: "ship it", status: "pending" },
    ])
  })

  test("drops entries that are not a todo, and a call with none renders nothing", () => {
    expect(parseTodos({ todos: [{ status: "pending" }, { content: "kept" }, "nope", null] })).toEqual([
      { content: "kept", status: "pending" },
    ])
    expect(parseTodos({})).toEqual([])
    expect(parseTodos({ todos: "not a list" })).toEqual([])
  })
})

describe("taskSessionID", () => {
  test("reads the child session out of the task tool's own output", () => {
    expect(taskSessionID('<task id="ses_child" state="completed">done</task>')).toBe("ses_child")
  })

  test("nothing to open is undefined, not a broken link", () => {
    expect(taskSessionID(undefined)).toBeUndefined()
    expect(taskSessionID("In progress")).toBeUndefined()
    expect(taskSessionID("<task state='completed'>no id</task>")).toBeUndefined()
  })
})

describe("outputLines", () => {
  test("one non-empty line per hit, trimmed", () => {
    expect(outputLines("src/a.ts\n\n  src/b.ts  \n")).toEqual(["src/a.ts", "src/b.ts"])
    expect(outputLines("")).toEqual([])
  })
})

describe("parseActionSummary", () => {
  test("reads the plugin's summary with URL, title, extracted data, steps and evidence", () => {
    expect(
      parseActionSummary(
        [
          'Acción "do_publish" completada.',
          "Origen: https://site",
          "URL: https://site/post",
          "Título: Mi post",
          "Extraído titulo: Hola",
          "Extraído fecha: 2026-01-01",
          "Pasos:",
          "- #1 fill: ok",
          "- #2 click: ok",
          "Evidencia: shot1, shot2",
        ].join("\n"),
      ),
    ).toEqual({
      action: "do_publish",
      origin: "https://site",
      url: "https://site/post",
      title: "Mi post",
      extracted: [
        { field: "titulo", value: "Hola" },
        { field: "fecha", value: "2026-01-01" },
      ],
      steps: [
        { index: 1, kind: "fill", status: "ok" },
        { index: 2, kind: "click", status: "ok" },
      ],
      evidence: ["shot1", "shot2"],
      extra: [],
    })
  })

  test("a summary with no steps still reads its action and origin", () => {
    expect(
      parseActionSummary(['Acción "read_demo" completada.', "Origen: https://site", "URL: https://site/page"].join("\n")),
    ).toEqual({
      action: "read_demo",
      origin: "https://site",
      url: "https://site/page",
      extracted: [],
      steps: [],
      evidence: [],
      extra: [],
    })
  })

  test("keeps the first URL and refuses to turn a script one into a link", () => {
    const summary = parseActionSummary(
      [
        'Acción "go" completada.',
        "Origen: https://site",
        "URL: https://safe.test/page",
        "Extraído campo: valor",
        "URL: javascript:alert(1)",
      ].join("\n"),
    )
    expect(summary?.url).toBe("https://safe.test/page")
    expect(actionLink(summary?.url ?? "")).toBe("https://safe.test/page")
    expect(actionLink("javascript:alert(1)")).toBeUndefined()
    expect(actionLink("https://ok.test")).toBe("https://ok.test")
  })

  test("reads a summary written with CRLF", () => {
    const summary = parseActionSummary(
      ['Acción "go" completada.', "Origen: https://site", "URL: https://site/page"].join("\r\n"),
    )
    expect(summary).toEqual({
      action: "go",
      origin: "https://site",
      url: "https://site/page",
      extracted: [],
      steps: [],
      evidence: [],
      extra: [],
    })
  })

  test("a malformed step between two valid ones does not lose the next", () => {
    const summary = parseActionSummary(
      [
        'Acción "go" completada.',
        "Origen: https://site",
        "Pasos:",
        "- #1 fill: ok",
        "esta línea no es un paso",
        "- #2 click: ok",
      ].join("\n"),
    )
    expect(summary?.steps).toEqual([
      { index: 1, kind: "fill", status: "ok" },
      { index: 2, kind: "click", status: "ok" },
    ])
    expect(summary?.extra).toEqual(["esta línea no es un paso"])
  })

  test("keeps an unknown line in extra instead of dropping it", () => {
    const summary = parseActionSummary(
      ['Acción "go" completada.', "Origen: https://site", "Nota: algo suelto"].join("\n"),
    )
    expect(summary?.extra).toEqual(["Nota: algo suelto"])
  })

  test("plain text and failure sentences are not mistaken for an action", () => {
    expect(parseActionSummary("esto es una salida normal")).toBeUndefined()
    expect(parseActionSummary("No se pudo contactar con el servidor del navegador.")).toBeUndefined()
    expect(parseActionSummary("La acción fue denegada por un guard (sin código).")).toBeUndefined()
    expect(parseActionSummary('Acción "x" completada.\nOrigen: no es una url')).toBeUndefined()
  })
})
