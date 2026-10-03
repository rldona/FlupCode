/**
 * Builds FlupCode Bridge into `dist/`, the folder Chrome loads unpacked and the store takes zipped
 * (README). The manifest's version is the package's, so the extension and the app move together.
 */
import { cp, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

export async function buildExtension(outdir = join(import.meta.dir, "..", "dist")) {
  const root = join(import.meta.dir, "..")
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })
  const result = await Bun.build({
    entrypoints: [join(root, "src", "background.ts"), join(root, "src", "popup.ts")],
    outdir,
    target: "browser",
    format: "esm",
  })
  if (!result.success) throw new AggregateError(result.logs, "FlupCode Bridge did not build")
  const manifest = await Bun.file(join(root, "manifest.json")).json()
  const version = (await Bun.file(join(root, "package.json")).json()).version
  await Bun.write(join(outdir, "manifest.json"), JSON.stringify({ ...manifest, version }, null, 2))
  await cp(join(root, "popup.html"), join(outdir, "popup.html"))
  await cp(join(root, "_locales"), join(outdir, "_locales"), { recursive: true })
  await cp(join(root, "icons"), join(outdir, "icons"), { recursive: true })
  return outdir
}

if (import.meta.main) console.log(`FlupCode Bridge built in ${await buildExtension()}`)
