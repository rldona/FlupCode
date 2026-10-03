import { expect, test } from "bun:test"
import { factsSummary, writeSummary } from "./semantic-checkpoint"

const facts = {
  after: "build",
  tasks: [
    { name: "plan", status: "success" as const, verdict: { value: "verified" as const, reason: "ok", source: "check" as const }, attempt: 1 },
    { name: "build", status: "success" as const, attempt: 2 },
    { name: "test", status: "queued" as const, attempt: 1 },
  ],
  files: Array.from({ length: 14 }, (_, index) => `src/file-${index}.ts`),
}

test("the facts summary names every task's state and verdict, and the files the step changed", () => {
  expect(factsSummary(facts)).toBe(
    [
      "After build: 2 of 3 tasks done.",
      "- plan: success, verified",
      "- build: success, attempt 2",
      "- test: queued",
      `Files changed in this step: ${facts.files.slice(0, 12).join(", ")} and 2 more.`,
    ].join("\n"),
  )
  expect(factsSummary({ ...facts, files: [] })).toEndWith("No files changed in this step.")
})

test("with no small model the summary is the facts, said to be, and no session is opened", async () => {
  const written = await writeSummary({
    engine: {
      createSession: () => {
        throw new Error("no session should be opened")
      },
    } as never,
    facts,
  })
  expect(written).toEqual({ text: factsSummary(facts), by: "facts" })
})
