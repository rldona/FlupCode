# Contributing

Thanks for helping build FlupCode. It runs on the official OpenCode 2 engine at a pinned version;
[docs/UPSTREAM.md](UPSTREAM.md) explains how that pin moves and why the engine is never patched here.

## Getting started

```bash
# clone the repository, then:
nvm use            # reads .nvmrc
bun install
bun run dev:harness
```

### Node

Bun runs the code, but a few tools still shell out to whatever `node` is first on your `PATH` —
`tsgo` (so `bun typecheck`, and the `pre-push` hook that runs it), Playwright, and
`electron-builder`. With an old Node they fail with errors that say nothing about your change:
`tsgo` reports *"Unable to resolve @typescript/native-preview-darwin-arm64"* because
`import.meta.resolve` does not exist before Node 18.19, and Playwright refuses outright.

`.nvmrc` pins **24.15**, which is what CI uses. The patch version is deliberate and is not a
rounding of "24": Playwright 1.59 hangs — does not fail, hangs — while extracting Chromium on Node
24.16. The e2e workflow carries the same pin and the same reason.

If your shell does not pick it up automatically, `nvm use` in the repository root is enough.

If `bun install` hits a private registry, force the public one:

```bash
npm_config_registry="https://registry.npmjs.org/" bun install --frozen-lockfile
```

## Language & conventions

**All code is written in English.** This applies to:

- variable, function, type and file names
- comments and doc comments
- commit messages, branch names, PR titles and issue text

User-facing text is **not hardcoded**. Put it through the app's i18n (`packages/harness/src/i18n.ts`),
defaulting to English. See ADR-0008.

### Commits and PR titles

Conventional commits: `type(scope): summary`. Valid types: `feat`, `fix`, `docs`, `chore`,
`refactor`, `test`. Scope examples: `harness`, `desktop`, `server`, `cli`, `docs`, `opencode` (a pin
bump).

Examples:

```
feat(harness): add project sidebar quick-create
fix(harness): keep composer focus after send
docs: add F2 design tokens
```

### Branches

Short, at most three words, hyphen-separated, no type prefixes:

```
harness-shell
sidebar-pinning
engine-proxy
```

### Style

Follow the style guide in `AGENTS.md`. In short:

- Prefer `const`; avoid `let` reassignment and `else` branches.
- Functional array methods over loops; type guards on `filter`.
- No `any`; no import aliases; no star imports.
- Don't extract single-use helpers preemptively.
- No comments for obvious code; comment non-obvious constraints.

## The engine boundary (important)

- The engine is the pinned OpenCode 2 binary. Reach it only through the adapters
  (`packages/harness/src/engine/`, `packages/harness-server/src/engine-v2.ts`) and extend it with a
  plugin (`packages/remote/src/engine-plugins-v2.ts`). An engine bug goes upstream as an issue or a
  pull request.
- Move the pin with `bun script/opencode-pin.ts bump` (or let the weekly `opencode-bump` PR do it);
  never edit one pin alone.

## Testing

Tests run from package directories, never the repo root:

```bash
bun --cwd packages/harness test
bun --cwd packages/harness typecheck
```

Before opening a PR, run `bun typecheck` from the affected package and make sure the harness
build passes.

## Pull requests

1. Branch off `power`, keep it focused.
2. Reference the ticket ID (e.g. `F2-4`) in the PR description.
3. Ensure CI passes (`typecheck`, harness build, tests).

### Pushing

Every push costs a CI run (`harness`: typecheck, unit, build and e2e on Linux). Commit locally
while iterating and push once the PR is ready, then batch follow-up tweaks into one push instead
of one push per small change.

### Merging

Merges happen on GitHub, never from Vercel, and one PR at a time:

1. **Rebase** the branch onto the current `origin/power` if it is behind, and push with
   `--force-with-lease`.
2. **Wait for CI** on that exact commit: `gate` (the last job of the `harness` workflow) is the
   required check on `power` and must finish green. It runs on every PR and only passes when the
   build and the engine suite passed, or were skipped because the PR does not touch their paths.
   Never merge on red or while it is still running.
3. **Merge with rebase**, so each conventional commit lands on `power` as written:

   ```bash
   gh pr merge <number> --rebase --repo rldona/FlupCode
   ```

4. **Several PRs:** merge them in order, infrastructure and CI changes first. After each merge,
   rebase the next PR onto the new `power` and wait for its CI again. Stop at the first conflict or
   red run.
5. **Keep your checkout alone:** rebase other branches in a `git worktree` (`git worktree add ../fc-x
   <branch>`), so the branch a local dev server is serving does not change under it.
6. **Clean up:** after merging, fast-forward `power` locally, and delete the merged branches and any
   worktrees.

### Deploys

- **Web:** Vercel deploys production from `power` only; other branches get no preview deployments.
  - **The app** (`app.flupcode.com`) builds only for a release: its `ignoreCommand` skips every push
    whose commit does not change the `version` in `packages/harness/package.json`, which only the
    release bump PR does. It ships with the desktop app and the CLI, not on every merge: on a busy
    day, building each merge meant some forty production builds.
  - **The landing** builds when a push touches `packages/landing`, compared against its last
    deployed commit (and it builds when Vercel's shallow clone no longer holds that commit).
  - A skipped build shows as "Canceled" in Vercel. That is the ignore step, not a failure.
- **Checking the web deploy:** `app.flupcode.com` updates a few minutes after a release bump is
  merged. Confirm it by fetching the served bundle and looking for something the release added, such
  as a new class name. To ship a web fix sooner, cut a patch release, or redeploy from the Vercel
  dashboard.
- **Desktop:** the desktop app only updates with a release; see [docs/RELEASE.md](RELEASE.md).

## Reporting issues

Tag issues with the phase/ticket they relate to. For upstream bugs that also affect OpenCode,
report them upstream and note the cross-reference here.
