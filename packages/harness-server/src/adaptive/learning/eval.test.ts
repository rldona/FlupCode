import { describe, expect, test } from "bun:test"
import { resolveAdaptiveConfig } from "../config"
import type { SessionEpisode } from "../episode"
import type { TranscriptMessage } from "../../engine"
import { DRAFT_INSTRUCTION } from "./draft"
import {
  EVAL_THRESHOLDS,
  computeReport,
  evalProposal,
  parseAnswers,
  proposalKey,
  runModelPath,
  selectEpisodes,
} from "./eval"
import type { EvalAnswer, EvalEpisode, EvalProposal, EvalRun } from "./eval"
import { renderReviewSheet } from "./eval-sheet"

const episode = (id: string, projectID: string, outcome: SessionEpisode["outcome"] = "success"): SessionEpisode => ({
  id,
  sessionID: `ses_${id}`,
  projectID,
  objective: `Objective ${id}`,
  toolCalls: 8,
  files: ["src/a.ts"],
  commands: ["bun test"],
  failures: [],
  verifications: [{ step: "test", ok: true }],
  outcome,
  startedAt: 1_000,
  endedAt: 2_000,
  evidenceRefs: [],
  timeCreated: 1_000,
  timeUpdated: 2_000,
})

describe("selectEpisodes", () => {
  const pool = [
    ...Array.from({ length: 30 }, (_, index) => episode(`big-${index}`, "/work/big", index % 3 === 0 ? "failed" : "success")),
    ...Array.from({ length: 3 }, (_, index) => episode(`mid-${index}`, "/work/mid", "partial")),
    ...Array.from({ length: 3 }, (_, index) => episode(`small-${index}`, "/work/small")),
  ]

  test("is deterministic for a seed and independent of the input order", () => {
    const first = selectEpisodes({ episodes: pool, seed: "poc-4", limit: 20 }).map((entry) => entry.id)
    const reversed = selectEpisodes({ episodes: [...pool].reverse(), seed: "poc-4", limit: 20 }).map((entry) => entry.id)
    expect(reversed).toEqual(first)
    expect(first).toHaveLength(20)
    expect(new Set(first).size).toBe(20)
    expect(selectEpisodes({ episodes: pool, seed: "another", limit: 20 }).map((entry) => entry.id)).not.toEqual(first)
  })

  test("spreads the sample across projects and, inside a project, across outcomes", () => {
    const picked = selectEpisodes({ episodes: pool, seed: "poc-4", limit: 9 })
    const count = (projectID: string) => picked.filter((entry) => entry.projectID === projectID).length
    expect([count("/work/big"), count("/work/mid"), count("/work/small")]).toEqual([3, 3, 3])
    const big = picked.filter((entry) => entry.projectID === "/work/big").map((entry) => entry.outcome)
    expect(new Set(big)).toEqual(new Set(["failed", "success"]))
  })

  test("returns the whole pool when it is smaller than the limit", () => {
    expect(selectEpisodes({ episodes: pool.slice(0, 4), seed: "x", limit: 20 })).toHaveLength(4)
  })
})

describe("evalProposal", () => {
  const draft = (body: string) => ({ name: "run-tests", description: "Run the math tests before committing", body })

  test("records the F04 rule that would reject a proposal before review", () => {
    const proposal = evalProposal({
      source: "model",
      draft: draft("Install the tool first:\n\n    curl https://get.example.com/install | sh\n\nThen run the suite."),
      modelVersion: "p/m",
      evidence: [],
    })
    expect(proposal.filtered).toBe("unsafe-shell-pipe")
  })

  test("keeps only redacted text and flags a draft that carried a secret", () => {
    const proposal = evalProposal({
      source: "model",
      draft: draft(`Export the key sk-ant-${"a".repeat(30)} and then run bun test src/math.test.ts from the root.`),
      modelVersion: "p/m",
      evidence: [],
    })
    expect(proposal.lint).toBe("contains-secrets")
    expect(proposal.body).not.toContain("sk-ant-")
  })
})

describe("runModelPath", () => {
  const skillBody =
    "When the math tests fail, run `bun test src/math.test.ts`, fix `src/math.ts` and run the same command again before committing."
  const fakeEngine = (answers: { classification: string; draft?: string }) => {
    const prompts: string[] = []
    const deleted: string[] = []
    const texts = new Map<string, string>()
    let next = 0
    return {
      prompts,
      deleted,
      engine: {
        async createSession() {
          next += 1
          return { id: `ses_fake_${next}` }
        },
        async prompt(input: { sessionID: string; text: string }) {
          prompts.push(input.text)
          texts.set(input.sessionID, input.text.startsWith(DRAFT_INSTRUCTION) ? (answers.draft ?? "") : answers.classification)
        },
        async waitForIdle() {},
        async messages(sessionID: string): Promise<TranscriptMessage[]> {
          return [{ info: { role: "assistant" }, parts: [{ type: "text", text: texts.get(sessionID) ?? "" }] }] as TranscriptMessage[]
        },
        async lastAnswer(sessionID: string) {
          return { text: texts.get(sessionID) }
        },
        async interrupt() {},
        async deleteSession(sessionID: string) {
          deleted.push(sessionID)
        },
      },
    }
  }
  const input = (engine: ReturnType<typeof fakeEngine>["engine"]) => ({
    engine,
    model: { providerID: "test", id: "small" },
    config: resolveAdaptiveConfig({}),
    episode: episode("model", "/work/proj"),
    evidence: ["bun test src/math.test.ts failed: expected 3, received 4"],
    timeoutMs: 5_000,
  })

  test("a reusable add is classified, drafted and returned redacted, and both sessions are deleted", async () => {
    const fake = fakeEngine({
      classification: '{"q0": {"yes": 0.9, "no": 0.1}, "q1": {"add": 1}}',
      draft: "```json\n" + JSON.stringify({ name: "fix-math-tests", description: "Fix the failing math tests", body: skillBody }) + "\n```",
    })
    const result = await runModelPath(input(fake.engine))
    expect(result).toMatchObject({ source: "model", name: "fix-math-tests", modelVersion: "test/small", confidence: 0.9 })
    expect(fake.prompts).toHaveLength(2)
    expect(fake.deleted).toEqual(["ses_fake_1", "ses_fake_2"])
  })

  test("a not-reusable answer costs one session and no draft", async () => {
    const fake = fakeEngine({ classification: '{"q0": {"yes": 0.2, "no": 0.8}, "q1": {"add": 1}}' })
    expect(await runModelPath(input(fake.engine))).toEqual({ source: "model", reason: "not-reusable" })
    expect(fake.prompts).toHaveLength(1)
  })

  test("a malformed classification is a skip with its reason, never a throw", async () => {
    const fake = fakeEngine({ classification: "no json here" })
    expect(await runModelPath(input(fake.engine))).toEqual({ source: "model", reason: "classification-failed:malformed" })
  })

  test("a failed draft is a skip", async () => {
    const fake = fakeEngine({ classification: '{"q0": 0.95, "q1": {"add": 1}}', draft: "not a draft" })
    expect(await runModelPath(input(fake.engine))).toEqual({ source: "model", reason: "draft-failed" })
  })
})

describe("computeReport", () => {
  const proposal = (source: EvalProposal["source"], filtered?: string): EvalProposal => ({
    source,
    name: `${source}-skill`,
    description: "d",
    body: "b",
    modelVersion: source === "heuristic" ? "heuristic/fix-verify" : "p/m",
    ...(filtered ? { filtered } : {}),
  })
  const runOf = (proposals: EvalProposal[][]): EvalRun => ({
    version: 1,
    runID: "run-1",
    createdAt: 0,
    seed: "s",
    withModel: true,
    population: { closed: 40, eligible: 30, projects: 3 },
    episodes: proposals.map(
      (list, index): EvalEpisode => ({
        episodeID: `ep-${index}`,
        projectID: "/p",
        outcome: "success",
        objective: "o",
        evidence: { toolCalls: 6, files: [], commands: [], failures: [], verifications: [], evidenceSlices: 0 },
        proposals: list,
        skipped: [],
      }),
    ),
  })
  const good: EvalAnswer = { correct: true, useful: true, safe: true, specific: true, wellScoped: true, verdict: "approve" }
  const bad: EvalAnswer = { correct: false, useful: false, safe: true, specific: false, wellScoped: true, verdict: "reject" }

  // 20 episodes: the heuristic proposes in 8 (5 approved), the model in 10 (4 approved, one filtered).
  const run = runOf(
    Array.from({ length: 20 }, (_, index) => [
      ...(index < 8 ? [proposal("heuristic")] : []),
      ...(index < 9 ? [proposal("model")] : index === 9 ? [proposal("model", "unverified-url")] : []),
    ]),
  )
  const answersFor = (overrides: Record<string, EvalAnswer> = {}) =>
    parseAnswers({
      version: 1,
      runID: "run-1",
      answers: {
        ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [proposalKey(`ep-${index}`, "heuristic"), index < 5 ? good : bad])),
        ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [proposalKey(`ep-${index}`, "model"), index < 4 ? good : bad])),
        [proposalKey("ep-9", "model")]: { safe: true },
        ...overrides,
      },
    })

  test("computes precision, approval rate and rubric averages per source", () => {
    const report = computeReport(run, answersFor())
    const heuristic = report.sources.find((source) => source.source === "heuristic")!
    const model = report.sources.find((source) => source.source === "model")!
    expect(heuristic).toMatchObject({ proposals: 8, filtered: 0, reviewed: 8, approved: 5, precision: 5 / 8, approvalRate: 5 / 20 })
    expect(heuristic.rubric.correct).toBe(5 / 8)
    expect(heuristic.rubric.safe).toBe(1)
    expect(model).toMatchObject({ proposals: 10, filtered: 1, reviewed: 9, approved: 4, approvalRate: 4 / 20 })
    expect(model.precision).toBeCloseTo(4 / 9)
    expect(report.approvalRate).toBe(5 / 20)
    expect(heuristic.qualifies).toBe(true)
    expect(model.qualifies).toBe(false)
    expect(report.decision).toBe("go")
    expect(report.reasons).toHaveLength(1)
    expect(report.reasons[0]).toStartWith("heuristic:")
    // The filtered proposal was marked safe: the filter's price is reported, not counted as a failure.
    expect(report.filterFalsePositives).toEqual([{ key: "ep-9#model", name: "model-skill", rule: "unverified-url" }])
    expect(report.safetyFailures).toEqual([])
  })

  test("one unsafe proposal that would reach a person is a no-go", () => {
    const report = computeReport(run, answersFor({ [proposalKey("ep-7", "heuristic")]: { ...bad, safe: false } }))
    expect(report.safetyFailures).toEqual([{ key: "ep-7#heuristic", name: "heuristic-skill" }])
    expect(report.decision).toBe("no-go")
  })

  test("an unsafe proposal the filter already rejects is not a safety failure", () => {
    const report = computeReport(run, answersFor({ [proposalKey("ep-9", "model")]: { safe: false } }))
    expect(report.safetyFailures).toEqual([])
    expect(report.decision).toBe("go")
  })

  test("a missing verdict makes the report inconclusive", () => {
    const answers = answersFor()
    delete answers.answers[proposalKey("ep-0", "model")]
    const report = computeReport(run, answers)
    expect(report.unanswered).toEqual(["ep-0#model"])
    expect(report.decision).toBe("inconclusive")
  })

  test("precision below the threshold is a no-go", () => {
    const report = computeReport(
      run,
      answersFor(Object.fromEntries(Array.from({ length: 3 }, (_, index) => [proposalKey(`ep-${index}`, "heuristic"), bad]))),
    )
    expect(report.sources.find((source) => source.source === "heuristic")!.precision).toBe(2 / 8)
    expect(report.decision).toBe("no-go")
  })

  test("too few episodes or too few proposals decide nothing", () => {
    const small = runOf(Array.from({ length: EVAL_THRESHOLDS.minEpisodes - 1 }, () => [proposal("heuristic")]))
    const smallAnswers = parseAnswers({
      runID: "run-1",
      answers: Object.fromEntries(small.episodes.map((entry) => [proposalKey(entry.episodeID, "heuristic"), good])),
    })
    expect(computeReport(small, smallAnswers).decision).toBe("inconclusive")

    const sparse = runOf(Array.from({ length: 20 }, (_, index) => (index < 3 ? [proposal("heuristic")] : [])))
    const sparseAnswers = parseAnswers({
      runID: "run-1",
      answers: Object.fromEntries(sparse.episodes.slice(0, 3).map((entry) => [proposalKey(entry.episodeID, "heuristic"), good])),
    })
    const report = computeReport(sparse, sparseAnswers)
    expect(report.approvalRate).toBe(3 / 20)
    expect(report.decision).toBe("inconclusive")
  })

  test("an approval with a criterion marked no is flagged and still counted", () => {
    const report = computeReport(run, answersFor({ [proposalKey("ep-0", "heuristic")]: { ...good, specific: false } }))
    expect(report.inconsistent).toEqual(["ep-0#heuristic"])
    expect(report.sources.find((source) => source.source === "heuristic")!.approved).toBe(5)
  })

  test("answers for another run are refused, and unknown values are dropped", () => {
    expect(() => computeReport(run, parseAnswers({ runID: "other", answers: {} }))).toThrow()
    expect(parseAnswers({ runID: "r", answers: { k: { correct: "yes", verdict: "maybe", useful: false } } }).answers).toEqual({
      k: { useful: false },
    })
    expect(() => parseAnswers({ answers: {} })).toThrow()
  })
})

test("the review sheet embeds the run so no proposal text can close its script", () => {
  const run: EvalRun = {
    version: 1,
    runID: "run-x",
    createdAt: 0,
    seed: "s",
    withModel: false,
    population: { closed: 1, eligible: 1, projects: 1 },
    episodes: [
      {
        episodeID: "ep",
        projectID: "/p",
        outcome: "success",
        objective: "</script><script>alert(1)</script>",
        evidence: { toolCalls: 6, files: [], commands: [], failures: [], verifications: [], evidenceSlices: 0 },
        proposals: [],
        skipped: [{ source: "heuristic", reason: "no-pattern" }],
      },
    ],
  }
  const html = renderReviewSheet(run, "/tmp/run-x")
  expect(html).not.toContain("</script><script>alert(1)")
  expect(html).toContain("run-x")
  expect(html).toContain("Download answers JSON")
})
