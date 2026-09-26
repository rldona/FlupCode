// The Chromium the harness drives ships with the app, in `browsers/`, so a machine with no browser
// of its own still gets one. `playwright install` downloads it into that folder and the desktop
// points the harness at it with PLAYWRIGHT_BROWSERS_PATH (WA-9).
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const browsers = path.resolve(here, "..", "browsers")

const result = spawnSync("bun", ["x", "playwright", "install", "chromium"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
})

if (result.error || result.status !== 0) {
  console.error(`Could not fetch Chromium into ${browsers}`)
  process.exit(result.status ?? 1)
}
console.log(`Chromium fetched into ${browsers}`)
