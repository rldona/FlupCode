import { expect, test } from "bun:test"
import { planExit } from "./plan-exit"

function engine(choice: string | undefined) {
  const switched: Array<[string, string]> = []
  const asked: Array<{ title: string; options: Array<{ value: string }> }> = []
  return {
    switched,
    asked,
    engine: {
      askChoice: async (input: { title: string; options: Array<{ value: string }> }) => {
        asked.push(input)
        return choice
      },
      switchAgent: async (sessionID: string, agent: string) => void switched.push([sessionID, agent]),
    },
  }
}

test("a yes switches the session to build, so the run goes on to implement the plan", async () => {
  const subject = engine("yes")
  expect(await planExit(subject.engine as never, "ses_1")).toEqual({ approved: true })
  expect(subject.asked[0]!.options.map((option) => option.value)).toEqual(["yes", "no"])
  expect(subject.switched).toEqual([["ses_1", "build"]])
})

test("a no, or no answer, keeps the plan agent", async () => {
  for (const choice of ["no", undefined]) {
    const subject = engine(choice)
    expect(await planExit(subject.engine as never, "ses_1")).toEqual({ approved: false })
    expect(subject.switched).toEqual([])
  }
})
