# Upstream

FlupCode runs on [OpenCode](https://github.com/anomalyco/opencode) 2 and inherits every new engine
capability, provider, tool and fix by moving one pinned version. It does not carry OpenCode's source:
until V2-71 this repository was a fork that merged OpenCode's `dev` branch into `power`, now `main` (ADR-0001);
[ADR-0027](adr/0027-official-opencode-binary.md) replaced that.

## The pin

FlupCode runs the **official OpenCode 2 binary** and follows upstream by moving one pinned version,
not by merging upstream's source ([ADR-0027](adr/0027-official-opencode-binary.md)).

- **The pin.** `OPENCODE_V2_VERSION` in `packages/remote/src/opencode-v2.ts` is the binary the
  desktop, `flupcode remote` and `flupcode serve` fetch. `@opencode/client` in the FlupCode
  `package.json` files is pinned to the same exact version.
- **The bump.** `.github/workflows/opencode-bump.yml` runs every Monday, and on demand with an
  optional version. It moves the pin to the newest 2.x release older than `minimumReleaseAge`
  (`bunfig.toml`, three days), refreshes `bun.lock` and opens or updates the `opencode-bump` pull
  request. The harness workflow then starts the new binary for real: the engine-contract suite and
  the live e2e (`test:e2e:engine`). Merge it once `gate` is green. Bump a major by hand.
- **By hand:** `bun script/opencode-pin.ts bump [version]`, then `bun install`. The script refuses a
  version younger than `minimumReleaseAge`, or one that any platform binary lacks.
- **The boundary.** FlupCode packages reach OpenCode only through the pinned npm packages.
  `bun script/opencode-pin.ts` (a step of the harness `build` job) fails on a version that disagrees
  with the pin, and on any file importing `@opencode-ai/*` that `docs/opencode-boundary.txt` does
  not list. The list is empty and stays that way.

An engine bug is fixed upstream or worked around in a plugin, never patched here.

## What FlupCode keeps from OpenCode

- Code it adapted and now maintains as its own, with OpenCode's MIT notice: the transcript's
  markdown renderer (`packages/harness/src/markdown/`) and the engine data shapes the app is written
  against (`packages/harness/src/engine/sdk-types.ts`).
- The engine's data, imported once from a 1.x database (`flupcode engine import-v1`, V2-61).

## When FlupCode needs something from the engine

1. A plugin (`packages/remote/src/engine-plugins-v2.ts`), if the 2.x plugin API can express it.
2. Otherwise an issue or a pull request in OpenCode's repository. FlupCode never patches the binary.
