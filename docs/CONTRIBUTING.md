# Contributing

Thanks for helping build FlupCode. This project is a fork of OpenCode; read
[docs/UPSTREAM.md](UPSTREAM.md) first, because the upstream boundary shapes how we work.

## Getting started

```bash
# clone your fork, then:
nvm use            # reads .nvmrc
bun install
git remote add upstream https://github.com/anomalyco/opencode.git
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

User-facing text is **not hardcoded**. Put it through i18n (`@solid-primitives/i18n`, same as
upstream), defaulting to English. See ADR-0008.

### Commits and PR titles

Conventional commits: `type(scope): summary`. Valid types: `feat`, `fix`, `docs`, `chore`,
`refactor`, `test`. Scope examples: `harness`, `desktop`, `docs`, `upstream`.

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
upstream-sync-action
```

### Style

Follow the upstream style guide in `AGENTS.md`. In short:

- Prefer `const`; avoid `let` reassignment and `else` branches.
- Functional array methods over loops; type guards on `filter`.
- No `any`; no import aliases; no star imports.
- Don't extract single-use helpers preemptively.
- No comments for obvious code; comment non-obvious constraints.
- Drizzle columns in `snake_case`.

## Upstream boundary (important)

- **Do not edit upstream packages** (`packages/opencode`, `server`, `core`, `protocol`, `schema`,
  `client`, `sdk`, `sdk-next`, `tui`, `app`, `desktop`, `ui`, `session-ui`). Wrap or extend from
  `packages/harness`.
- Keep changes to shared root files (`package.json`, `bun.lock`, `bunfig.toml`, `.github/**`) as
  small and additive as possible.
- When an upstream merge conflicts, upstream wins for `packages/**`; we win for our files.

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
4. Follow the conflict policy in [docs/UPSTREAM.md](UPSTREAM.md).

### Pushing

Every push costs a CI run (`harness`: build, unit and e2e on Linux and Windows). Commit locally
while iterating and push once the PR is ready, then batch follow-up tweaks into one push instead
of one push per small change.

### Merging

Merges happen on GitHub, never from Vercel, and one PR at a time:

1. **Rebase** the branch onto the current `origin/power` if it is behind, and push with
   `--force-with-lease`.
2. **Wait for CI** on that exact commit: the `harness` workflow must finish green. Never merge on red
   or while it is still running.
3. **Merge with rebase**, which keeps the history linear with no merge commits:

   ```bash
   gh pr merge <number> --rebase
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
  Each Vercel project skips its build when a push did not touch it: `packages/landing` for the
  landing, and `packages/harness` or the packages it builds from for the app (`ignoreCommand` in each
  `vercel.json`). It compares against the project's last deployed commit, and builds when Vercel's
  shallow clone no longer holds that commit.
- **Checking the web deploy:** `app.flupcode.com` updates a few minutes after a merge. Confirm it by
  fetching the served bundle and looking for something the change added, such as a new class name.
- **Desktop:** the desktop app only updates with a release; see [docs/RELEASE.md](RELEASE.md).

## Reporting issues

Tag issues with the phase/ticket they relate to. For upstream bugs that also affect OpenCode,
report them upstream and note the cross-reference here.
