// The Chromium the harness drives is an extra resource like the server binary: electron-builder
// skips a resource that is not there without failing, which is how a packaged app would end up with
// no browser at all. This refuses to package instead (WA-9).
import { existsSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const browsers = path.resolve(here, "..", "browsers")
const found = existsSync(browsers) && readdirSync(browsers).some((name) => name.startsWith("chromium-"))

if (!found) {
  console.error(
    `No Chromium in ${browsers}. Expected a chromium-* folder — run \`bun scripts/fetch-browser.mjs\`.`,
  )
  process.exit(1)
}
console.log(`browser to package: ${browsers}`)
