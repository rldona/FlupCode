#!/usr/bin/env bun
/**
 * The standalone harness server.
 *
 * `bun build --compile` leaves a runtime `require.resolve` pointing at the build machine's absolute
 * path: Bun cannot bundle a lookup that only happens at run time. playwright-core's `nodePlatform`
 * asks for its own `package.json` the moment the package is imported, so the binary that ships
 * without `node_modules` died there before it could launch a browser. The only readers of that path
 * are stack-trace prefixes, so the plugin replaces the lookup with a path no real frame can start
 * with: `coreDir` stops naming the package but keeps the frame filters from swallowing every frame,
 * which an empty value would — the same reason `managedExecutableFromDir` finds the browser by layout.
 *
 *   bun script/build.ts [arch...]   one binary per architecture, in `dist/<arch>/`: by default every
 *                                   architecture the desktop packages on this OS, so the x64 Mac app
 *                                   gets an x86_64 server and not the build machine's (HE-05)
 */
import path from "node:path"
import { packagedArchs } from "../../harness-desktop/scripts/archs.mjs"

const PACKAGE_LOOKUP = 'import_path.default.dirname(require.resolve("../../../package.json"))'
// Not empty: `boxedStackPrefixes` uses `file.startsWith(prefix)` and every path starts with "", so an
// empty `coreDir` would filter out all stack frames. This sentinel matches none of them.
const MISSING_PACKAGE_DIR = '"/playwright-core-not-bundled"'
const NODE_PLATFORM = /playwright-core[\\/]lib[\\/]server[\\/]utils[\\/]nodePlatform\.js$/
const directory = path.resolve(import.meta.dir, "..")
const archs = process.argv.length > 2 ? process.argv.slice(2) : packagedArchs()
const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform as string]

for (const arch of archs) {
  const outfile = path.join(directory, "dist", arch, "flupcode-harness")
  const target = `bun-${os}-${arch}` as Bun.Build.CompileTarget
  const result = await Bun.build({
    entrypoints: [path.join(directory, "src", "index.ts")],
    compile: { outfile, target },
    external: ["chromium-bidi"],
    plugins: [
      {
        name: "drop-playwright-package-lookup",
        setup(build) {
          build.onLoad({ filter: NODE_PLATFORM }, async (args) => {
            const source = await Bun.file(args.path).text()
            const patched = source.replace(PACKAGE_LOOKUP, MISSING_PACKAGE_DIR)
            if (patched === source)
              throw new Error(
                `playwright's package lookup moved; the build plugin in script/build.ts must be updated (${args.path})`,
              )
            return { contents: patched, loader: "js" }
          })
        },
      },
    ],
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  console.log(`harness server to package: ${path.relative(directory, outfile)}`)
}
