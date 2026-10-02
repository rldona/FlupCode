// The harness server is compiled into the app as an extra resource. electron-builder skips a
// resource that is not there without failing, which is how 1.8.0 shipped a Windows app with no
// server and a green build. This refuses to package instead, for every architecture this OS
// packages: each installer takes the server built for its own (HE-05).
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { packagedArchs } from "./archs.mjs"

const names = ["flupcode-harness", "flupcode-harness.exe"]
const missing = packagedArchs().filter((arch) => {
  const directory = fileURLToPath(new URL(`../../harness-server/dist/${arch}/`, import.meta.url))
  const found = names.find((name) => existsSync(directory + name))
  if (found) console.log(`harness server to package: ${arch}/${found}`)
  return !found
})

if (missing.length > 0) {
  console.error(
    `No harness server binary for ${missing.join(", ")} in harness-server/dist/<arch>/. Expected one of ${names.join(", ")} — ` +
      "`bun --cwd ../harness-server build` writes them, and `bun build --compile` adds .exe on Windows.",
  )
  process.exit(1)
}
