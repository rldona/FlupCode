/**
 * Print the heuristic reflection candidates over a harness database, read-only (AH-F01).
 *
 *   bun run reflect:heuristics -- [--db <path>] [--limit 200] [--project <dir>] [--json]
 *
 * It exists for the manual precision review: it replays the closed episodes in the order they
 * closed, applies the same deterministic gate and classifier as the manager, skips a name already
 * proposed (in the database or earlier in the replay), and prints each candidate with its text
 * redacted. The database is opened `readonly` and never migrated; the episode traces are read from
 * the plugin's signal files (`FLUPCODE_EPISODE_SIGNALS_DIR` overrides where). Nothing is written.
 */

import { Database } from "bun:sqlite"
import { parseArgs } from "node:util"
import { decodeEpisode, defaultDatabasePath } from "../../repository"
import type { EpisodeRow } from "../../repository"
import { DEFAULT_LEARNING_CONFIG } from "../config"
import { redactText } from "../redaction"
import { classifyEpisode, episodeTrace } from "./heuristics"
import { reflectionGate } from "./reflection-job"

if (import.meta.main) {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: {
      db: { type: "string", default: process.env.FLUPCODE_HARNESS_DB ?? defaultDatabasePath() },
      limit: { type: "string", default: "200" },
      project: { type: "string" },
      json: { type: "boolean", default: false },
    },
  }).values
  const db = new Database(args.db, { readonly: true })
  const limit = Math.max(1, Math.floor(Number(args.limit)) || 200)
  const rows = db
    .query(
      `SELECT * FROM (
         SELECT * FROM session_episodes
         WHERE ended_at IS NOT NULL ${args.project ? "AND project_id = ?2" : ""}
         ORDER BY ended_at DESC LIMIT ?1
       ) ORDER BY ended_at ASC, id ASC`,
    )
    .all(...((args.project ? [limit, args.project] : [limit]) as never[])) as EpisodeRow[]
  const proposed = new Set(
    (db.query("SELECT project_id, name FROM skill_proposals WHERE name IS NOT NULL").all() as Array<{
      project_id: string
      name: string
    }>).map((row) => `${row.project_id}\n${row.name}`),
  )
  db.close()

  const episodes = rows.map(decodeEpisode)
  const gated = new Set(
    episodes.filter((episode) => reflectionGate(episode, DEFAULT_LEARNING_CONFIG).reflect).map((episode) => episode.id),
  )
  const candidates = episodes.flatMap((episode, index) => {
    if (!gated.has(episode.id)) return []
    const candidate = classifyEpisode({ episode, trace: episodeTrace(episode), history: episodes.slice(0, index).reverse() })
    if (!candidate) return []
    const key = `${episode.projectID}\n${candidate.name}`
    if (proposed.has(key)) return []
    proposed.add(key)
    return [
      {
        episodeID: episode.id,
        projectID: episode.projectID,
        objective: redactText(episode.objective),
        pattern: candidate.pattern,
        confidence: candidate.confidence,
        name: redactText(candidate.name),
        description: redactText(candidate.description),
        body: redactText(candidate.body),
        supportingEpisodes: candidate.supportingEpisodes,
      },
    ]
  })

  if (args.json) {
    console.log(JSON.stringify({ episodes: episodes.length, gated: gated.size, candidates }, null, 2))
    process.exit(0)
  }
  console.log(
    `${episodes.length} closed episodes read, ${gated.size} past the gate, ${candidates.length} candidate proposals (read-only; nothing was written).`,
  )
  console.log("Review: mark each candidate useful or not; precision = useful / reviewed.\n")
  candidates.forEach((candidate, index) => {
    console.log(`#${index + 1} [${candidate.pattern} · ${candidate.confidence.toFixed(2)}] ${candidate.name}`)
    console.log(`episode: ${candidate.episodeID}  project: ${candidate.projectID}`)
    console.log(`objective: ${candidate.objective}`)
    console.log(`description: ${candidate.description}`)
    if (candidate.supportingEpisodes.length > 0) console.log(`supporting: ${candidate.supportingEpisodes.join(", ")}`)
    console.log(`${candidate.body}\n${"-".repeat(72)}`)
  })
}
