// The Chromium the harness drives is an extra resource like the server binary: electron-builder
// skips a resource that is not there without failing, which is how a packaged app would end up with
// no browser at all. This refuses to package instead (WA-9), for every architecture this OS packages:
// each installer takes the browser fetched for its own (HE-05).
import { existsSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { packagedArchs } from "./archs.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const missing = packagedArchs().filter((arch) => {
  const browsers = path.resolve(here, "..", "browsers", arch)
  const found = existsSync(browsers) && readdirSync(browsers).some((name) => name.startsWith("chromium-"))
  if (found) console.log(`browser to package: ${browsers}`)
  return !found
})

if (missing.length > 0) {
  console.error(
    `No Chromium for ${missing.join(", ")} in browsers/<arch>/. Expected a chromium-* folder — run \`bun scripts/fetch-browser.mjs\`.`,
  )
  process.exit(1)
}
