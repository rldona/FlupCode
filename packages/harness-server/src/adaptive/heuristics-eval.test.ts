/**
 * The heuristic reflection eval (AH-F01): without any model, the classifier stages proposals on a
 * labelled corpus with precision ≥ 0.6, and recall is reported.
 *
 * The corpus (`fixtures/heuristics/reflection-corpus.json`) is synthetic and anonymised: positives of
 * both patterns, near misses (a flaky rerun, an unrelated edit, a red test that stays red, a bare
 * `pytest`) and two cases the heuristic is known to get wrong, so the numbers are honest rather than
 * perfect. Cases are replayed in order the way the manager sees them: the deterministic gate first,
 * the earlier episodes as history, and one proposal per skill name (a recurring pattern is staged once).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_LEARNING_CONFIG } from "./config"
import type { EpisodeFailure, SessionEpisode } from "./episode"
import { sessionEpisodeID } from "./episode"
import { classifyEpisode } from "./learning/heuristics"
import type { HeuristicPattern, TraceStep } from "./learning/heuristics"
import { validateProposal } from "./learning/proposal"
import { reflectionGate } from "./learning/reflection-job"

type Case = {
  id: string
  label: HeuristicPattern | "none"
  note: string
  episode: {
    sessionID: string
    projectID: string
    objective: string
    toolCalls: number
    files: string[]
    commands: string[]
    failures: EpisodeFailure[]
    startedAt: number
    endedAt: number
  }
  trace?: TraceStep[]
}

const corpus = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "heuristics", "reflection-corpus.json"), "utf8"),
) as { cases: Case[] }

const episodeOf = (entry: Case): SessionEpisode => ({
  ...entry.episode,
  id: sessionEpisodeID(entry.episode.sessionID),
  verifications: [],
  outcome: "partial",
  evidenceRefs: [`session:${entry.episode.sessionID}`],
  timeCreated: entry.episode.endedAt,
  timeUpdated: entry.episode.endedAt,
})

/** The corpus replayed like the manager does, one case at a time, with the earlier ones as history. */
function replay() {
  const episodes = corpus.cases.map(episodeOf)
  const staged = new Set<string>()
  return corpus.cases.map((entry, index) => {
    const episode = episodes[index]!
    if (!reflectionGate(episode, DEFAULT_LEARNING_CONFIG).reflect) return { entry, predicted: undefined }
    const candidate = classifyEpisode({ episode, trace: entry.trace ?? [], history: episodes.slice(0, index).reverse() })
    if (!candidate || staged.has(candidate.name)) return { entry, predicted: undefined }
    staged.add(candidate.name)
    return { entry, predicted: candidate }
  })
}

describe("heuristic reflection eval (AH-F01)", () => {
  test("the corpus has at least 20 labelled episodes, with positives of both patterns and negatives", () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(20)
    expect(new Set(corpus.cases.map((entry) => entry.id)).size).toBe(corpus.cases.length)
    for (const label of ["fix-verify", "repeated-command", "none"]) {
      expect(corpus.cases.some((entry) => entry.label === label)).toBe(true)
    }
  })

  test("precision ≥ 0.6 without a model, recall reported", () => {
    const results = replay()
    const predicted = results.filter((result) => result.predicted)
    const truePositives = predicted.filter((result) => result.predicted!.pattern === result.entry.label)
    const expected = results.filter((result) => result.entry.label !== "none")
    const precision = truePositives.length / predicted.length
    const recall = truePositives.length / expected.length

    const rows = results.map(
      (result) =>
        `${result.entry.id.padEnd(26)} expected=${result.entry.label.padEnd(16)} got=${(result.predicted?.pattern ?? "none").padEnd(16)} ${result.predicted?.name ?? ""}`,
    )
    console.log(
      [
        `heuristic reflection eval: precision ${precision.toFixed(2)} (${truePositives.length}/${predicted.length}), recall ${recall.toFixed(2)} (${truePositives.length}/${expected.length})`,
        ...rows,
      ].join("\n"),
    )

    expect(predicted.length).toBeGreaterThan(0)
    expect(precision).toBeGreaterThanOrEqual(0.6)
    // Not the acceptance bar, but a floor so a regression that stops proposing anything is visible.
    expect(recall).toBeGreaterThanOrEqual(0.5)
  })

  test("every staged candidate passes the proposal lint and carries no secret-shaped text", () => {
    const results = replay()
    for (const result of results) {
      if (!result.predicted) continue
      const validation = validateProposal({
        projectID: result.entry.episode.projectID,
        episodeID: sessionEpisodeID(result.entry.episode.sessionID),
        intent: "add",
        name: result.predicted.name,
        description: result.predicted.description,
        body: result.predicted.body,
        evidenceRefs: [`session:${result.entry.episode.sessionID}`],
      })
      expect(validation).toMatchObject({ ok: true })
    }
  })

  test("the replay is deterministic: the same corpus yields the same proposals, byte for byte", () => {
    expect(JSON.stringify(replay())).toBe(JSON.stringify(replay()))
  })
})
