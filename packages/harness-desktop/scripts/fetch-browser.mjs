// The Chromium the harness drives ships with the app, in `browsers/`, so a machine with no browser
// of its own still gets one. `playwright install` downloads it into that folder and the desktop
// points the harness at it with PLAYWRIGHT_BROWSERS_PATH (WA-9).
//
// One per architecture the app packages, in `browsers/<arch>/` (HE-05): the x64 Mac app's harness
// looks for `chrome-mac-x64`, so the build machine's arm64 Chromium left it with no browser of its
// own. Playwright picks the download by the machine it runs on; on macOS it is told the other one.
// Every macOS 11+ entry of its registry names the same Chrome for Testing archive per CPU.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { packagedArchs } from "./archs.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
// `bun x playwright` takes the latest release, which can point at a `playwright-core` that is not
// published yet. The harness runs the catalog's Playwright, so fetch exactly that one.
const playwright = JSON.parse(readFileSync(path.resolve(here, "../../..", "package.json"), "utf8")).workspaces.catalog.playwright

if (typeof playwright !== "string") {
  console.error("No Playwright version in the workspace catalog")
  process.exit(1)
}

for (const arch of packagedArchs()) {
  const browsers = path.resolve(here, "..", "browsers", arch)
  const result = spawnSync("bun", ["x", `playwright@${playwright}`, "install", "chromium"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: browsers,
      ...(process.platform === "darwin"
        ? { PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: arch === "arm64" ? "mac15-arm64" : "mac15" }
        : {}),
    },
  })
  if (result.error || result.status !== 0) {
    console.error(`Could not fetch Chromium into ${browsers}`)
    process.exit(result.status ?? 1)
  }
  console.log(`Chromium fetched into ${browsers}`)
}
