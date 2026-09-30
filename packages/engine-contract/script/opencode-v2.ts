#!/usr/bin/env bun

// The OpenCode 2.x sandbox (V2-05): a pinned binary FlupCode owns, run with its own home.
//
//   bun script/opencode-v2.ts install              fetch and verify the pinned binary, print its path
//   bun script/opencode-v2.ts serve [--port 4196] [--directory <dir>]
//                                                  run it with the sandbox home and a fresh password
//
// The sandbox home lives under FlupCode's cache, so the engine's database, config and credentials
// are its own: it never opens ~/.local/share/opencode/opencode.db, which OpenCode 2 would migrate one
// way on first start. Delete `<cache>/flupcode/engines/sandbox-<version>` to start from scratch.

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { installOpenCodeV2, OPENCODE_V2_VERSION, openCodeV2Path } from "../src/opencode-v2"

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { port: { type: "string", default: "4196" }, directory: { type: "string" } },
})

const binary = await installOpenCodeV2()
if (positionals[0] === "install") {
  console.log(binary)
  process.exit(0)
}
if (positionals[0] !== "serve") {
  console.error("usage: bun script/opencode-v2.ts install | serve [--port 4196] [--directory <dir>]")
  process.exit(1)
}

const sandbox = join(openCodeV2Path(), "..", "..", `sandbox-${OPENCODE_V2_VERSION}`)
const home = join(sandbox, "home")
const directory = values.directory ?? join(sandbox, "project")
mkdirSync(home, { recursive: true })
mkdirSync(directory, { recursive: true })
const password = crypto.randomUUID()

console.log(`OpenCode ${OPENCODE_V2_VERSION} sandbox on http://127.0.0.1:${values.port}`)
console.log(`  user opencode, password ${password}`)
console.log(`  home ${home}`)
const child = Bun.spawn([binary, "serve", "--port", values.port, "--hostname", "127.0.0.1"], {
  cwd: directory,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    OPENCODE_PASSWORD: password,
  },
  stdio: ["inherit", "inherit", "inherit"],
})
process.on("SIGINT", () => child.kill("SIGTERM"))
process.exit(await child.exited)
