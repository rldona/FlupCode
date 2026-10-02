// The architectures electron-builder packages on this OS: every `arch` of `build.<os>.target` in
// package.json. A sidecar the app ships (the harness server, the speech helper, the browser) is built
// or fetched once for each, into a folder named after it, and `extraResources` packages the one that
// matches with `${arch}`: one copy for every installer is how the x64 Mac app shipped arm64
// binaries (HE-05).
//
//   node scripts/archs.mjs   prints them, space-separated, for shell scripts
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

export function packagedArchs() {
  const build = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).build
  const os = { darwin: "mac", win32: "win", linux: "linux" }[process.platform]
  const targets = build[os]?.target ?? []
  const archs = [...new Set(targets.flatMap((target) => target.arch ?? []))]
  if (archs.length === 0) throw new Error(`package.json packages no architecture for ${process.platform}`)
  return archs
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(packagedArchs().join(" "))
