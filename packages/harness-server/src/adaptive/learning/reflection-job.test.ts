import { describe, expect, test } from "bun:test"
import { DEFAULT_LEARNING_CONFIG } from "../config"
import type { LearningConfig } from "../config"
import type { SessionEpisode } from "../episode"
import {
  REFLECTION_SIGNAL_LIMIT,
  reflectionCandidates,
  reflectionGate,
  reflectionGateBatch,
  reflectionSignals,
} from "./reflection-job"

const learning = (overrides: Partial<LearningConfig> = {}): LearningConfig => ({
  ...DEFAULT_LEARNING_CONFIG,
  enabled: true,
  minToolCalls: 5,
  ...overrides,
})

const episode = (overrides: Partial<SessionEpisode> = {}): SessionEpisode => ({
  id: "episode:run:1",
  sessionID: "ses_1",
  projectID: "/work/project",
  objective: "Fix the failing test",
  toolCalls: 12,
  files: ["src/a.ts"],
  commands: ["bun test"],
  failures: [],
  verifications: [{ step: "test", ok: true }],
  outcome: "success",
  startedAt: 1_000,
  endedAt: 2_000,
  evidenceRefs: [],
  timeCreated: 2_000,
  timeUpdated: 2_000,
  ...overrides,
})

describe("the deterministic evidence gate (FH-030)", () => {
  test("a busy episode clears the gate exactly once; a silent one never does", () => {
    const busy = reflectionGateBatch([episode()], learning())
    expect(busy.reflect).toHaveLength(1)
    expect(busy.skipped).toEqual([])

    // Quiet: below the cadence, so nothing is even looked at.
    const below = reflectionGateBatch([episode({ toolCalls: 1 })], learning())
    expect(below.reflect).toHaveLength(0)
    expect(below.skipped).toEqual([{ episodeID: "episode:run:1", reason: "below-threshold" }])

    // Busy enough but left nothing: a call that did nothing non-obvious is not a lesson.
    const empty = reflectionGateBatch([episode({ verifications: [], files: [], failures: [] })], learning())
    expect(empty.reflect).toHaveLength(0)
    expect(empty.skipped).toEqual([{ episodeID: "episode:run:1", reason: "no-signal" }])
  })

  test("the cadence threshold comes from the learning config", () => {
    const episodeUnderTest = episode({ toolCalls: 4, files: [], verifications: [{ step: "test", ok: true }] })
    expect(reflectionGate(episodeUnderTest, learning({ minToolCalls: 3 }))).toEqual({ reflect: true })
    expect(reflectionGate(episodeUnderTest, learning({ minToolCalls: 5 }))).toEqual({
      reflect: false,
      reason: "below-threshold",
    })
  })

  test("a failure or a verification is a signal on its own", () => {
    const failure = episode({ files: [], verifications: [], failures: [{ summary: "test failed" }] })
    expect(reflectionGate(failure, learning())).toEqual({ reflect: true })
    const verification = episode({ files: [], verifications: [{ step: "test", ok: false }] })
    expect(reflectionGate(verification, learning())).toEqual({ reflect: true })
  })

  test("signals are stable, bounded and anchored to what happened", () => {
    const signals = reflectionSignals(
      episode({
        verifications: [
          { step: "test", ok: true },
          { step: "lint", ok: false },
        ],
        files: ["src/a.ts"],
        failures: [{ summary: "boom" }],
      }),
    )
    expect(signals).toEqual(["verify:test ok", "verify:lint fail", "file:src/a.ts", "failure:boom"])
    expect(
      reflectionSignals(episode({ files: Array.from({ length: 50 }, (_, index) => `src/${index}.ts`) })),
    ).toHaveLength(REFLECTION_SIGNAL_LIMIT)
  })
})

describe("the sweep backstop (FH-030)", () => {
  test("only terminal episodes with no job yet are candidates", () => {
    const terminal = episode({ id: "episode:run:terminal" })
    const live = episode({ id: "episode:run:live", endedAt: undefined })
    const already = episode({ id: "episode:run:already" })
    const candidates = reflectionCandidates({
      episodes: [terminal, live, already],
      hasJob: (episodeID) => episodeID === already.id,
    })
    expect(candidates.map((entry) => entry.id)).toEqual(["episode:run:terminal"])
  })

  test("the sweep is bounded so a restart cannot walk an unbounded history", () => {
    const episodes = Array.from({ length: 10 }, (_, index) => episode({ id: `episode:run:${index}` }))
    expect(reflectionCandidates({ episodes, hasJob: () => false, limit: 3 })).toHaveLength(3)
    expect(reflectionCandidates({ episodes, hasJob: () => false })).toHaveLength(10)
  })
})
