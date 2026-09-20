import { spawnSync } from "node:child_process"
import { cp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const desktop = path.resolve(here, "..")
const harness = path.resolve(desktop, "..", "harness")

const build = spawnSync("bun", ["run", "--cwd", harness, "build", "--base", "./"], { stdio: "inherit", shell: true })
if (build.status !== 0) process.exit(build.status ?? 1)

const target = path.resolve(desktop, "out", "renderer")
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(path.resolve(harness, "dist"), target, { recursive: true })

console.log(`Copied ${path.relative(desktop, target)}`)
