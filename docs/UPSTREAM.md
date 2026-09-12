# Upstream

OpenHarness tracks [anomalyco/opencode](https://github.com/anomalyco/opencode) so we inherit every
new engine capability, provider, tool and fix. This document defines how we do that without
fighting merge conflicts.

## Remotes

| Remote | URL | Role |
| --- | --- | --- |
| `origin` | `https://github.com/rldona/OpenHarness.git` | Our fork. We push here. |
| `upstream` | `https://github.com/anomalyco/opencode.git` | Read-only source of truth. |

## Branches

| Branch | Meaning |
| --- | --- |
| `dev` | Fast-forward mirror of `upstream/dev`. **Never commit here.** |
| `power` | Product branch. All OpenHarness work. Default branch of the fork. |

> Upstream's default branch is `dev` (not `main`), so our mirror is `dev` too. There is no `main`.

`power` contains only additive changes plus a small number of deliberately-owned files
(`README.md`, `docs/**`, `packages/harness/**`, `.github/workflows/upstream-sync.yml`). Because we
never edit upstream packages, merges are almost always clean.

## Sync workflow

### Automated (normal case)

`.github/workflows/upstream-sync.yml` runs on a schedule and on manual dispatch:

1. Fast-forwards `dev` to `upstream/dev`.
2. Opens (or updates) a pull request `dev → power`.
3. The PR must pass `bun typecheck` and the harness build before merging.

Review the PR, resolve any conflict in *our* files (almost always keep-ours), and merge.

### Manual (local)

```bash
# 1. Refresh the pristine mirror
git switch dev
git fetch upstream
git merge --ff-only upstream/dev
git push origin dev

# 2. Bring the product branch up to date
git switch power
git merge dev
# resolve conflicts only in OpenHarness-owned files
git push origin power
```

If `git merge --ff-only upstream/dev` fails, `dev` has diverged — it must be reset, never merged:

```bash
git switch dev
git reset --hard upstream/dev
git push --force-with-lease origin dev
```

## Conflict policy

| File / area | On conflict |
| --- | --- |
| `packages/**` (upstream packages) | **Take upstream.** We never modify them. |
| `packages/harness/**`, `packages/harness-desktop/**` | **Keep ours.** Resolve manually if upstream changed a dependency we reuse. |
| `docs/**` | **Keep ours.** |
| `README.md` | **Keep ours.** |
| `bun.lock`, `package.json` (root) | Merge carefully; prefer upstream versions, re-add our root scripts. |
| `.github/workflows/**` | Keep ours; adopt new upstream workflows. |

## Adding a root script

Root `package.json` is upstream-owned. Add harness scripts next to the existing ones and keep the
diff to those lines only:

```jsonc
"dev:harness": "bun --cwd packages/harness dev",
"build:harness": "bun --cwd packages/harness build"
```

## Forbidden changes

- Editing any upstream package to make our UI work.
- Committing directly to `dev`.
- Force-pushing `power` (use `--force-with-lease` only after a rebase you own).
