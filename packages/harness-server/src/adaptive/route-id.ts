/**
 * An audit id from a request path. Decision, plan and proposal ids carry `:`
 * (`skillRelevance:episode:run:…`, `proposal:<episodeID>`) and the client encodes them, so the segment
 * is decoded; a malformed escape is no id at all rather than a thrown request.
 */
export function decodedID(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}
