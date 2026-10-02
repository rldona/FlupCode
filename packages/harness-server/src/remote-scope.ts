/**
 * What a phone may do with the harness over remote control (HE-02).
 *
 * The remote host carries `/harness/*` through the tunnel with its own bearer, the `remote` scope, and
 * the server decides here what that bearer reaches (P7): reading runs and artifacts, letting a run
 * through its gate, and stopping one. A run's requests are answered in the engine, which the tunnel
 * already reaches, so they need nothing here. Anything not listed is refused, whatever it is: config
 * writes, workflows, routines, settings, pairing, browser grants, the plugins' routes. An allow-list,
 * so a route added later is refused over remote control until someone decides it belongs here.
 */

const RUN_READS = new Set(["tasks", "activity", "files", "tools"])
const ARTIFACT_READS = new Set(["raw", "versions", "export"])

/** Whether the `remote` scope reaches `method` on `path` (the request's path split on `/`). */
export function remoteScopeAllows(method: string, path: string[]) {
  if (path[0] !== "harness") return false
  const group = path[1]
  const action = path[3] ?? ""
  if (method === "GET") {
    if (group === "health" || group === "events") return path.length === 2
    if (group === "runs") return path.length <= 3 || (path.length === 4 && RUN_READS.has(action))
    // What a run spent: the run card's figure (UL-06).
    if (group === "usage") return path[2] === "runs" && path.length === 4
    if (group === "artifacts") return path.length <= 3 || (path.length === 4 && ARTIFACT_READS.has(action))
    return false
  }
  // A gate is a question: let it through, or stop the run. There is no third answer.
  return method === "POST" && group === "runs" && path.length === 4 && (action === "approve" || action === "stop")
}

/** The server events a phone follows: its runs, their tasks and what they left (HE-02). */
const REMOTE_EVENTS = new Set(["run.started", "run.changed", "run.removed", "task.changed", "artifact.created", "artifact.changed"])

export const remoteEvent = (event: { type: string }) => REMOTE_EVENTS.has(event.type)
