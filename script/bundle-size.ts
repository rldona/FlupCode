/**
 * The web app's startup weight (UX-00), checked against the build in `packages/harness/dist`.
 *
 * The main chunk is the entry script `index.html` loads; startup is that chunk plus every chunk the page
 * preloads with it (the third-party code and the Spanish dictionary, split apart so a release leaves
 * them cached). Screens and dialogs load on demand and are not counted: that is what keeps them out.
 * Both limits are checked, so moving code into a chunk that still loads at startup does not pass for
 * making startup lighter.
 *
 *   bun run --cwd packages/harness build && bun script/bundle-size.ts
 */
import path from "node:path"

const LIMITS = { main: 500_000, startup: 750_000 }

const dist = path.join(import.meta.dir, "..", "packages", "harness", "dist")
const html = await Bun.file(path.join(dist, "index.html")).text()
const entry = html.match(/<script type="module"[^>]*src="([^"]+)"/)?.[1]
if (!entry) throw new Error("index.html loads no module script: build the web app first")
const preloads = [...html.matchAll(/<link rel="modulepreload"[^>]*href="([^"]+)"/g)].map((match) => match[1]!)
const sizes = await Promise.all(
  [entry, ...preloads].map(async (file) => ({ file, bytes: Bun.file(path.join(dist, file)).size })),
)
const main = sizes[0]!.bytes
const startup = sizes.reduce((total, chunk) => total + chunk.bytes, 0)

sizes.forEach((chunk) => console.log(`${kB(chunk.bytes).padStart(10)}  ${chunk.file}`))
console.log(`${kB(main).padStart(10)}  main chunk (limit ${kB(LIMITS.main)})`)
console.log(`${kB(startup).padStart(10)}  startup (limit ${kB(LIMITS.startup)})`)

const over = [
  main > LIMITS.main ? `the main chunk is ${kB(main)}, over ${kB(LIMITS.main)}` : undefined,
  startup > LIMITS.startup ? `startup is ${kB(startup)}, over ${kB(LIMITS.startup)}` : undefined,
].filter((message) => message !== undefined)
if (over.length > 0) {
  console.error(`Too heavy: ${over.join("; ")}. Load the new code on demand (see features/shell/Screens.tsx).`)
  process.exit(1)
}

function kB(bytes: number) {
  return `${(bytes / 1000).toFixed(1)} kB`
}
