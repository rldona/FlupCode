import { openCodeV2Database } from "@flupcode/remote/opencode-v2"
import { importV1History, rollbackV1Import } from "@flupcode/remote/v1-import"

/**
 * `flupcode-harness engine-data import-v1 [<1.x database>]` and `… rollback-import` (V2-61): the
 * desktop's "Import OpenCode 1.x History" menu, run by this binary because it is the one the app ships
 * that has Bun's SQLite. One JSON line on stdout either way, so the desktop reads the outcome without
 * parsing prose. The caller stops FlupCode's 2.x engine first and starts it again after.
 */
export function runEngineDataCommand(args: string[]) {
  const [command, from] = args
  const target = openCodeV2Database()
  try {
    if (command === "import-v1") return answer(importV1History({ ...(from ? { source: from } : {}), target }))
    if (command === "rollback-import") return answer(rollbackV1Import({ target }))
    return answer({ error: `unknown engine-data command "${command ?? ""}"` }, 2)
  } catch (cause) {
    return answer({ error: cause instanceof Error ? cause.message : String(cause) }, 1)
  }
}

function answer(value: object, code = 0) {
  console.log(JSON.stringify(value))
  return code
}
