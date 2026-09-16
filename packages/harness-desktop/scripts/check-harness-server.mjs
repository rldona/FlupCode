// The harness server is compiled into the app as an extra resource. electron-builder skips a
// resource that is not there without failing, which is how 1.8.0 shipped a Windows app with no
// server and a green build. This refuses to package instead.
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const directory = fileURLToPath(new URL("../../harness-server/dist/", import.meta.url))
const names = ["flupcode-harness", "flupcode-harness.exe"]
const found = names.find((name) => existsSync(directory + name))

if (!found) {
  console.error(
    `No harness server binary in ${directory}. Expected one of ${names.join(", ")} — ` +
      "`bun --cwd ../harness-server build` writes it, and `bun build --compile` adds .exe on Windows.",
  )
  process.exit(1)
}
console.log(`harness server to package: ${found}`)
