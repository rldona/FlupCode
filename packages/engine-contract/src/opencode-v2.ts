import { readFileSync } from "node:fs"
import { join } from "node:path"
import { installOpenCodeV2, OPENCODE_V2_VERSION } from "@flupcode/remote/opencode-v2"

/**
 * The pinned OpenCode 2.x binary for the V2 sandbox (V2-05): the one the launchers start (V2-60),
 * fetched under the repo's own `minimumReleaseAge`, so the sandbox follows the same rule as bun. The
 * binary is not run here; the contract suite and `script/opencode-v2.ts` do that with an isolated
 * home, so it never opens the user's `opencode.db`.
 */
export function installSandboxOpenCodeV2(version = OPENCODE_V2_VERSION) {
  return installOpenCodeV2({ version, minimumReleaseAge: minimumReleaseAge() })
}

/** The repo's `[install] minimumReleaseAge`, in seconds. */
function minimumReleaseAge() {
  const bunfig = readFileSync(join(import.meta.dir, "..", "..", "..", "bunfig.toml"), "utf8")
  return Number(bunfig.match(/^minimumReleaseAge\s*=\s*(\d+)/m)?.[1] ?? 259_200)
}
