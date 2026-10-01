# ADR-0027: FlupCode runs on the official OpenCode 2, not on a fork

- **Status:** Accepted. The decision holds now; the removals it describes land with V2-71.
- **Date:** 2026-10-01
- **Supersedes:** [ADR-0001](0001-fork-and-upstream-sync.md) (fork and upstream synchronisation)
- **Related:** `docs/V2-MIGRATION-AUDIT.md` (V2-70, V2-71), [ADR-0009](0009-engine-api-layer.md),
  [UPSTREAM.md](../UPSTREAM.md)

## Context

ADR-0001 made FlupCode a fork of `anomalyco/opencode`. That was right while FlupCode needed the
engine's source: the 1.x engine had no plugin surface for memory, `plan_exit` or the permission
floor, so we patched upstream packages and merged `dev` into `power` to keep up.

OpenCode 2 changed both reasons:

- **What FlupCode adds is a plugin now.** Memory, `plan_exit`, permission modes, web actions, the
  adaptive layer and the runtime probe ship as 2.x plugins (`@flupcode/remote/engine-plugins-v2`).
  None of them needs an engine patch.
- **FlupCode already runs the official binary.** Since 2.0.0 the desktop, `flupcode remote` and
  `flupcode serve` start `@opencode/cli-<platform>` at the version pinned in
  `OPENCODE_V2_VERSION`, fetched from npm and checked against its published integrity. The apps
  talk to it through `@opencode/client` from npm at the same version. The vendored engine in
  `packages/opencode`, `packages/core` and the rest is not what our users run.

And the fork sync no longer works. The open sync PR (#343) changes 6,756 files and adds about 1.4M
lines, because upstream's `dev` and `power` no longer share a recent merge base. Resolving it would
mean re-merging an engine nobody runs.

## Decision

1. **The engine is an artifact, not source.** FlupCode runs the official OpenCode 2 binary at one
   pinned version. It is never built from source here, and never patched. When FlupCode needs
   something from the engine, it asks for it through a plugin, or upstream through an issue or a
   pull request.
2. **One pin.** `OPENCODE_V2_VERSION` in `packages/remote/src/opencode-v2.ts` is the version of the
   binary. Every FlupCode `package.json` that depends on `@opencode/client` (or later
   `@opencode/plugin`) pins that same exact version. `script/opencode-pin.ts` checks this in CI.
3. **Tracking upstream means bumping the pin.** A scheduled workflow (`opencode-bump.yml`) opens an
   `opencode-bump` pull request for the newest 2.x release that is older than the repo's
   `minimumReleaseAge`. The pull request runs the same gates as any change to the engine boundary:
   the engine-contract suite against the real binary and the live e2e (`test:e2e:engine`). A major
   version is bumped by hand.
4. **A shrinking boundary.** FlupCode packages reach upstream only through those pinned npm
   packages. `docs/opencode-boundary.txt` lists the files that still import `@opencode-ai/*`, or
   depend on an upstream workspace package. CI fails on any file not listed, and reports listed files
   that no longer need it, so the list only shrinks. V2-71 ends with an empty list, which is the
   audit's acceptance (`rg "@opencode-ai/"` finds nothing in FlupCode packages).
5. **The repository stays.** `rldona/FlupCode` keeps its releases (the desktop's auto-update feed),
   its issues and its deployments, but stops being a working fork. In V2-71 the upstream packages,
   upstream's workflows, the `dev` mirror and `upstream-sync.yml` are removed, and the root
   workspace keeps only FlupCode's packages.
6. **The fork sync stops now.** `upstream-sync.yml` no longer runs on a schedule. It can still be
   dispatched by hand until V2-71. `dev` stays where it is as the last mirror.

## Consequences

- An engine bug is fixed upstream or worked around in a plugin. We can no longer carry a local
  patch until upstream merges it. In exchange, a sync is a one-line bump that a test suite judges,
  not a merge of thousands of files.
- The upstream inventory (`docs/upstream-inventory.txt`) and its CI job describe the fork. They
  stay until V2-71 removes the files they protect, and then go with them.
- Before V2-71, each file on the boundary list needs its own replacement:
  - The transcript's markdown renderer (`@opencode-ai/session-ui`) and its styles (`@opencode-ai/ui`)
    become FlupCode's own.
  - The shared engine types (`engine-types.ts`, today derived from the 1.x SDK) are defined from
    `@opencode/client` or by FlupCode.
  - The 1.x-only users (`engine/v1.ts`, `harness-server/src/engine.ts`, the 1.x web-actions plugin)
    go with V1 itself.
- `catalog:` versions, `patches/` and the root tooling come from the upstream monorepo's root. V2-71
  trims them to what FlupCode's packages use.
