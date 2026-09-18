/**
 * Plans the agent wrote to disk (H-14).
 *
 * The `plan` agent writes `.opencode/plans/*.md` inside the project. Those files are the harness's
 * own work in every sense except one: the harness never produced them, so nothing registered them.
 * The audit asks for exactly this — "el registro automático de los planes que escribe el agente
 * `plan` en `.opencode/plans/*.md`".
 *
 * Registration is lazy: it happens while somebody is looking at the artifacts of a folder, because
 * that is when a plan is worth indexing and the only time the folder is known. The artifact keeps a
 * snapshot and the path, so the file can be read where it lives.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { artifactHash, type ArtifactRepository } from "./repository"
import type { Artifact } from "./types"

const PLANS_DIRECTORY = join(".opencode", "plans")

export type PlanFile = { path: string; title: string; content: string }

/** The first heading, or the file's name: enough to recognise the plan in a list. */
const titleOf = (content: string, path: string) => {
  const heading = content.split("\n").find((line) => /^#\s+\S/.test(line))
  return heading ? heading.replace(/^#\s+/, "").trim() : path.split("/").pop()!.replace(/\.md$/i, "")
}

/** Every `.md` directly under a project's `.opencode/plans`, oldest name order. Absent folder is empty. */
export function discoverPlans(directory: string): PlanFile[] {
  const root = join(directory, PLANS_DIRECTORY)
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  return names
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .sort()
    .flatMap((name) => {
      const full = join(root, name)
      try {
        if (!statSync(full).isFile()) return []
      } catch {
        return []
      }
      try {
        const content = readFileSync(full, "utf8")
        const path = join(PLANS_DIRECTORY, name)
        return [{ path, title: titleOf(content, path), content }]
      } catch {
        return []
      }
    })
}

/**
 * Indexes the plans of a folder that are not indexed yet, and returns the ones it added.
 *
 * Deduplicated by path **and** content: reading the same plan twice adds nothing, but a plan that
 * was rewritten is kept as a new snapshot rather than silently leaving the old one on screen.
 */
export function registerPlans(repository: ArtifactRepository, directory: string): Artifact[] {
  const known = new Set(
    repository
      .listArtifacts({ directory, kind: "plan" })
      .filter((artifact) => artifact.path && artifact.hash)
      .map((artifact) => `${artifact.path}\0${artifact.hash}`),
  )
  const added: Artifact[] = []
  for (const plan of discoverPlans(directory)) {
    if (known.has(`${plan.path}\0${artifactHash(plan.content)}`)) continue
    added.push(
      repository.addArtifact({
        kind: "plan",
        title: plan.title,
        producer: "agent",
        content: plan.content,
        path: plan.path,
        directory,
      }),
    )
  }
  return added
}
