#!/usr/bin/env bun

// FlupCode runs the official OpenCode 2 at one pinned version (ADR-0027). This keeps that pin
// honest, and the boundary to the vendored upstream packages shrinking until V2-71 removes them.
//
//   bun script/opencode-pin.ts                  check: one version everywhere, no new boundary file
//   bun script/opencode-pin.ts --update         rewrite docs/opencode-boundary.txt from the tree
//   bun script/opencode-pin.ts bump [version]   move the pin to <version>, or to the newest 2.x
//                                               release older than bunfig's minimumReleaseAge

import { $ } from "bun"
import path from "path"

const PACKAGES = ["engine-contract", "flupcode-cli", "harness", "harness-desktop", "harness-server", "relay", "remote"]
const PIN_FILE = "packages/remote/src/opencode-v2.ts"
const BOUNDARY = "docs/opencode-boundary.txt"
const REGISTRY = "https://registry.npmjs.org"
// The packages that ship the pinned version, and the binaries `installOpenCodeV2` fetches.
const PINNED = /^@opencode\/(client|plugin)$/
const PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-arm64-musl",
  "linux-x64",
  "linux-x64-musl",
  "windows-arm64",
  "windows-x64",
]

const root = (await $`git rev-parse --show-toplevel`.text()).trim()
const manifests = PACKAGES.map((name) => `packages/${name}/package.json`)
const pinned = await readPin()

if (process.argv[2] === "bump") await bump(process.argv[3])
if (process.argv[2] !== "bump") await check(process.argv.includes("--update"))

async function check(update: boolean) {
  const drift = (await Promise.all(manifests.map(readManifest))).flatMap((manifest) =>
    dependencies(manifest.json)
      .filter((dep) => PINNED.test(dep.name) && dep.version !== pinned)
      .map((dep) => `${manifest.file}: ${dep.name} is ${dep.version}, the binary is ${pinned} (${PIN_FILE})`),
  )
  const crossing = await boundaryFiles()
  if (update) {
    await Bun.write(path.join(root, BOUNDARY), header() + crossing.map((file) => `${file}\n`).join(""))
    console.log(`${BOUNDARY}: ${crossing.length} files`)
  }
  const declared = update ? crossing : await readBoundary()
  const undeclared = crossing.filter((file) => !declared.includes(file))
  const cleared = declared.filter((file) => !crossing.includes(file))

  drift.forEach((line) => console.error(`::error::${line}`))
  undeclared.forEach((file) =>
    console.error(
      `::error file=${file}::${file} reaches upstream outside the pinned OpenCode 2 packages. Use @opencode/client, or own it (ADR-0027).`,
    ),
  )
  // Not a failure: the list is meant to shrink, and the pull request that shrinks it can say so.
  cleared.forEach((file) => console.log(`::notice::${file} no longer crosses the boundary; drop it from ${BOUNDARY}`))
  if (drift.length > 0 || undeclared.length > 0) process.exit(1)
  console.log(`OpenCode ${pinned} everywhere; ${crossing.length} files still cross the boundary (V2-71 empties it)`)
}

async function bump(requested: string | undefined) {
  const age = await minimumReleaseAge()
  const target = requested ?? (await newestEligible(age))
  if (target.split(".")[0] !== pinned.split(".")[0])
    throw new Error(`${target} is another major than ${pinned}: bump a major by hand`)
  const youngest = await publishedAt(target)
  if (Date.now() - youngest < age * 1000)
    throw new Error(`OpenCode ${target} is younger than minimumReleaseAge (${age}s); wait or pin an older one`)
  if (target === pinned) {
    console.log(`OpenCode ${pinned} is already the newest eligible release`)
    await output("")
    return
  }
  await rewrite(path.join(root, PIN_FILE), (text) => text.replace(/(OPENCODE_V2_VERSION = ")[^"]+"/, `$1${target}"`))
  await Promise.all(
    manifests.map((file) =>
      rewrite(path.join(root, file), (text) =>
        text.replace(/("@opencode\/(?:client|plugin)": ")[^"]+"/g, `$1${target}"`),
      ),
    ),
  )
  console.log(`OpenCode ${pinned} -> ${target}. Run bun install to refresh bun.lock.`)
  await output(target)
}

/** Every FlupCode file that imports a vendored upstream package or depends on one. */
async function boundaryFiles() {
  const files = (
    await $`git ls-files --cached --others --exclude-standard -- ${PACKAGES.map((name) => `packages/${name}`)}`
      .cwd(root)
      .text()
  )
    .split("\n")
    .filter((file) => /\.(ts|tsx|js|mjs|css|json)$/.test(file))
  const crossing = await Promise.all(
    files.map(async (file) => {
      const source = Bun.file(path.join(root, file))
      // Deleted in the working tree but still in the index.
      if (!(await source.exists())) return undefined
      const text = await source.text()
      if (file.endsWith("package.json")) return dependencies(JSON.parse(text)).some(upstream) ? file : undefined
      return /["']@opencode-ai\//.test(text) ? file : undefined
    }),
  )
  return crossing.filter((file): file is string => file !== undefined).sort()
}

function upstream(dep: { name: string; version: string }) {
  if (dep.name.startsWith("@opencode-ai/")) return true
  return dep.version.startsWith("workspace:") && !dep.name.startsWith("@flupcode/")
}

function dependencies(json: Record<string, unknown>) {
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((field) =>
    Object.entries((json[field] ?? {}) as Record<string, string>).map(([name, version]) => ({ name, version })),
  )
}

async function readManifest(file: string) {
  return { file, json: (await Bun.file(path.join(root, file)).json()) as Record<string, unknown> }
}

async function readPin() {
  const match = (await Bun.file(path.join(root, PIN_FILE)).text()).match(/OPENCODE_V2_VERSION = "([^"]+)"/)
  if (!match) throw new Error(`${PIN_FILE} has no OPENCODE_V2_VERSION`)
  return match[1]
}

async function readBoundary() {
  return (await Bun.file(path.join(root, BOUNDARY)).text())
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
}

function header() {
  return [
    "# FlupCode files that still reach the vendored upstream packages (ADR-0027).",
    "# CI fails on a file not listed here; this list only shrinks, and V2-71 empties it.",
    "# Regenerate with: bun script/opencode-pin.ts --update",
    "",
  ]
    .map((line) => `${line}\n`)
    .join("")
}

async function minimumReleaseAge() {
  const match = (await Bun.file(path.join(root, "bunfig.toml")).text()).match(/^minimumReleaseAge\s*=\s*(\d+)/m)
  return match ? Number(match[1]) : 0
}

/** The newest release of the pinned major that every package FlupCode fetches has, old enough. */
async function newestEligible(age: number) {
  const client = await packument("@opencode/client")
  const major = pinned.split(".")[0]
  const candidates = Object.keys(client.versions)
    .filter((version) => new RegExp(`^${major}\\.\\d+\\.\\d+$`).test(version))
    .filter((version) => Date.now() - Date.parse(client.time[version]) >= age * 1000)
    .sort(compare)
    .reverse()
  for (const version of candidates) {
    const youngest = await publishedAt(version).catch(() => undefined)
    if (youngest !== undefined && Date.now() - youngest >= age * 1000) return version
  }
  return pinned
}

/** When the last of the client, the CLI and the platform binaries for `version` was published. */
async function publishedAt(version: string) {
  const names = ["@opencode/client", "@opencode/cli", ...PLATFORMS.map((platform) => `@opencode/cli-${platform}`)]
  const times = await Promise.all(
    names.map(async (name) => {
      const published = Date.parse((await packument(name)).time[version] ?? "")
      if (!Number.isFinite(published)) throw new Error(`${name}@${version} is not on the registry`)
      return published
    }),
  )
  return Math.max(...times)
}

async function packument(name: string) {
  const response = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}`)
  if (!response.ok) throw new Error(`GET ${name} answered ${response.status}`)
  return (await response.json()) as { versions: Record<string, unknown>; time: Record<string, string> }
}

function compare(a: string, b: string) {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
}

async function rewrite(file: string, change: (text: string) => string) {
  await Bun.write(file, change(await Bun.file(file).text()))
}

/** The bumped version for the workflow (empty when nothing moved) and the one it replaces. */
async function output(version: string) {
  if (!process.env.GITHUB_OUTPUT) return
  await Bun.write(
    process.env.GITHUB_OUTPUT,
    `${await Bun.file(process.env.GITHUB_OUTPUT).text()}version=${version}\nfrom=${pinned}\n`,
  )
}
