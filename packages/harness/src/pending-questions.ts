/**
 * Which sessions are waiting on a question answer (QH-1).
 *
 * The `blocked` list mixes both kinds of stuck work, but only question entries carry a
 * `questions` array — permission entries never do. Sessions with an actionable question (at
 * least one option to answer) get the yellow hand instead of the dot, so a question is told
 * apart from a permission at a glance. Pure, so it can be tested without a server.
 */

export type PendingRequest = {
  sessionID: string
  questions?: unknown
}

export function questionSessions(requests: PendingRequest[] | undefined): string[] {
  if (!requests) return []
  return [
    ...new Set(
      requests
        .filter((request) => Array.isArray(request.questions) && request.questions.length > 0)
        .map((request) => request.sessionID),
    ),
  ]
}
