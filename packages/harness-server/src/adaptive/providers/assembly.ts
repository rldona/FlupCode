/**
 * Answer assembly by question id (FH-013b).
 *
 * Concurrent responses come back unordered, so an answer is matched by its id and never by the
 * position it arrived at. The returned map keeps the caller's question order and drops answers the
 * provider did not send, so a missing answer reads as missing rather than as the previous one.
 */

export function assembleById<A>(ids: readonly string[], answers: ReadonlyMap<string, A>): Map<string, A> {
  return new Map(ids.flatMap((id) => {
    const answer = answers.get(id)
    return answer === undefined ? [] : [[id, answer] as const]
  }))
}
