# Upstream

FlupCode tracks [anomalyco/opencode](https://github.com/anomalyco/opencode) so we inherit every
new engine capability, provider, tool and fix. This document defines how we do that without
fighting merge conflicts.

## Remotes

| Remote     | URL                                         | Role                       |
| ---------- | ------------------------------------------- | -------------------------- |
| `origin`   | `https://github.com/rldona/FlupCode.git`    | Our fork. We push here.    |
| `upstream` | `https://github.com/anomalyco/opencode.git` | Read-only source of truth. |

## Branches

| Branch  | Meaning                                                        |
| ------- | -------------------------------------------------------------- |
| `dev`   | Fast-forward mirror of `upstream/dev`. **Never commit here.**  |
| `power` | Product branch. All FlupCode work. Default branch of the fork. |

> Upstream's default branch is `dev` (not `main`), so our mirror is `dev` too. There is no `main`.

Most of `power` is additive, and most syncs are clean. But we _do_ edit upstream packages, so
"take upstream on `packages/**`" is not a safe blanket rule. See
[What we own inside upstream packages](#what-we-own-inside-upstream-packages) for the inventory
that the [conflict policy](#conflict-policy) depends on, and keep it current: a sync resolved
against a stale inventory silently drops our work.

Some upstream root files are removed on `power` because they describe OpenCode, not FlupCode: the
README translations (`README.*.md`) and `STATS.md`. If an upstream change touches one of them, the
merge reports a modify/delete conflict; resolve it by keeping them deleted (`git rm <file>`). The
package READMEs under `packages/` stay: they document upstream code we still ship.

## Sync workflow

### Automated (normal case)

`.github/workflows/upstream-sync.yml` runs on a schedule and on manual dispatch:

1. Fast-forwards `dev` to `upstream/dev`.
2. Opens (or updates) a pull request `dev → power`.
3. The PR must pass `bun typecheck` and the harness build before merging.

Review the PR, resolve each conflict by the [conflict policy](#conflict-policy) — the answer is
not always keep-ours — and merge with a **merge commit** (see [Merge methods](#merge-methods)).

The workflow authenticates with the `UPSTREAM_SYNC_TOKEN` repository secret, a personal access
token with the `repo` and `workflow` scopes. The scope matters: the default `GITHUB_TOKEN` is
refused when a push touches `.github/workflows/`, which upstream changes regularly, so the mirror
cannot fast-forward without it. Renew the token before it expires; the workflow fails fast with an
explicit error when the secret is missing.

### Manual (local)

```bash
# 1. Refresh the pristine mirror
git switch dev
git fetch upstream
git merge --ff-only upstream/dev
git push origin dev

# 2. Merge into a branch off power, never into power itself
git switch -c sync-upstream-<date> power
git merge dev
# resolve conflicts by the conflict policy below
git push -u origin sync-upstream-<date>
gh pr create --base power --title "chore(upstream): sync dev into power"
```

`power` is protected: it takes no direct pushes, so the merge has to arrive through a pull
request. Resolving the conflict on `dev` instead is not an option either — a commit on the mirror
breaks the `--ff-only` of the next sync. Merging a branch that already contains the merge keeps
`dev` as a parent of `power`, which is what keeps the merge base accurate.

If `git merge --ff-only upstream/dev` fails, `dev` has diverged — it must be reset, never merged:

```bash
git switch dev
git reset --hard upstream/dev
git push --force-with-lease origin dev
```

## Merge methods

`power` allows merge commits and squash, and rebase-merge is disabled at the repository. Pick the
method by the kind of change:

| Pull request                  | Method           | Why                                                                                                                  |
| ----------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `dev → power` (upstream sync) | **Merge commit** | Keeps upstream's commit SHAs in `power`, so the next sync sees an accurate merge base instead of re-applying changes |
| Feature / fix                 | **Squash**       | One conventional commit per change; keeps the product history linear and readable                                    |

Rebase-merge is intentionally off: replaying `dev` onto `power` rewrites upstream commit SHAs, and
every following sync then re-proposes changes already applied.

## What we own inside upstream packages

Every file under `packages/` that differs from the mirror is listed in
[`docs/upstream-inventory.txt`](./upstream-inventory.txt), and CI fails a pull request that changes
an upstream package without declaring it there (`.github/workflows/upstream-inventory.yml`).
Refresh it with:

```bash
bun script/upstream-inventory.ts --update
```

The check only proves a file is _declared_. Which of the rules below applies to it is still
something a human writes down here, in the matching section — a line added to the inventory
without a word in this document tells the next resolver nothing.

Review what actually changed with:

```bash
git diff --name-status origin/dev origin/power -- packages \
  | grep -vE "harness|landing|flupcode-cli|packages/relay|packages/remote"
```

### Whole packages that are ours

`packages/flupcode-cli`, `packages/harness`, `packages/harness-desktop`, `packages/harness-server`,
`packages/landing`, `packages/relay`, `packages/remote`. They do not exist upstream, so they never
conflict. **Keep ours.**

### Files we added inside upstream packages

Persistent memory (`packages/core/src/memory.ts`, `packages/core/src/memory/**`,
`packages/core/src/config/memory.ts`, `packages/core/src/tool/memory.ts`,
`packages/schema/src/memory.ts`, `packages/protocol/src/groups/memory.ts`,
`packages/server/src/handlers/memory.ts`, the `20260914143517_add_memory` migration) and the
`plan_exit` tool (`packages/core/src/tool/plan-exit.ts`), plus their tests. The light-reload test
(`packages/opencode/test/config/reload.test.ts`) is also ours. New paths, so they only conflict
through the registries below. **Keep ours.**

### Registry lines

One-line registrations that make the files above reachable:
`packages/core/src/tool/builtins.ts`, `packages/core/src/location-services.ts`,
`packages/core/src/config.ts`, `packages/core/src/database/migration.gen.ts`,
`packages/schema/src/index.ts`, `packages/schema/src/session.ts`, `packages/protocol/src/api.ts`,
`packages/protocol/src/errors.ts`, `packages/server/src/handlers.ts`,
`packages/client/src/contract.ts`, `packages/core/src/v1/config/config.ts` (the generic
`flupcode.composeTools`/`flupcode.configRepo` fields the FlupCode apps read),
`packages/core/src/v1/config/migrate.ts`,
`packages/core/src/session/info.ts`.

**Take upstream, then re-add our line.** Never keep our whole version: upstream adds entries to
these same lists, and keeping ours drops them.

### Generated files

`packages/client/src/generated/**`, `packages/client/src/generated-effect/**`,
`packages/sdk/js/src/v2/gen/**`, `packages/core/schema.json`,
`packages/core/src/database/schema.gen.ts`.

**Never hand-merge.** Take upstream, then regenerate: `bun run generate` from `packages/client`,
and `./packages/sdk/js/script/build.ts` for the legacy JS SDK. A hand-resolved generated file
looks right and diverges from its source of truth.

### Behavioral edits to upstream code

These change how upstream code behaves, and a careless "take upstream" reintroduces the bug each
one fixes. **Keep ours, re-applied on top of upstream's new version** — never as a blind
keep-ours, because upstream may have changed the surrounding code.

| File                                                                                         | What we changed and why                                                                                                                                      |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/permission.ts`                                                            | The agent's permissions act as a capability floor, so a session-level `*: allow` (our permission modes) cannot turn the Plan agent's denial into an approval |
| `packages/core/src/session/projector.ts`                                                     | Deleting a session also deletes its session-scoped memories and its memory-usage rows                                                                        |
| `packages/core/src/session/runner/llm.ts`                                                    | Memory capture and retrieval around the provider turn                                                                                                        |
| `packages/core/src/session/runner/model.ts`                                                  | Adds `resolveRef` and the GitHub Copilot provider path                                                                                                       |
| `packages/core/src/plugin/provider/github-copilot.ts`, `packages/opencode/src/auth/index.ts` | Our GitHub Copilot integration and credential storage                                                                                                        |
| `packages/core/src/plugin/agent.ts`                                                          | Plan agent system prompt that ends in `plan_exit`                                                                                                            |
| `packages/opencode/src/agent/agent.ts`                                                       | Hidden `cowork` agent                                                                                                                                        |
| `packages/opencode/src/cli/cmd/serve.ts`                                                     | A taken port reports the address instead of a bare `ServeError`                                                                                              |
| `packages/llm/src/protocols/openai-chat.ts`                                                  | Drops reasoning-only assistant turns that OpenAI Chat rejects on replay                                                                                      |
| `packages/llm/src/route/executor.ts`, `packages/llm/src/schema/errors.ts`                    | Retry budget and which transport errors are retryable                                                                                                        |
| `packages/opencode/src/server/routes/instance/httpapi/**`                                    | `revertCommit` endpoint and the light reload (`POST /config/reload`)                                                                                         |
| `packages/core/src/skill.ts`, `packages/opencode/src/config/config.ts`, `packages/opencode/src/skill/index.ts`, `packages/opencode/src/command/index.ts`, `packages/opencode/src/session/processor.ts`, `packages/opencode/src/tool/registry.ts` | Light config reload: a per-directory `reload()` so a saved agent/command/tool takes effect without disposing instances, `SkillV2.reload` clearing its cache, `ToolRegistry.reload` invalidating its per-directory state so `POST /config/reload` rescans the tool directories, and the doom-loop skipping the ask when the named agent is gone |
| `packages/core/src/v1/config/config.ts`                                                      | The `flupcode.configRepo` field: an absolute path to the user's own config repository that the FlupCode apps may export to, which the engine only carries                                         |
| `packages/session-ui/src/components/message-part.tsx`, `message-file.ts`, `message-part.css` | The timeline renders the images a completed tool returned (its `state.attachments`), not only the files of a user message: thumbnails that open `ImagePreview` |

Their tests move with them: `packages/core/test/**`, `packages/llm/test/**`,
`packages/opencode/test/**` follow the same rule as the file they cover.

## Conflict policy

| File / area                                                                       | On conflict                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/**` not listed below                                                    | **Take upstream.**                                                                                                                                                                       |
| Packages that are ours (`harness*`, `landing`, `flupcode-cli`, `relay`, `remote`) | **Keep ours.**                                                                                                                                                                           |
| Files we added inside upstream packages                                           | **Keep ours.**                                                                                                                                                                           |
| Registry lines                                                                    | **Take upstream, re-add our line.**                                                                                                                                                      |
| Generated files                                                                   | **Take upstream, then regenerate.** Never hand-merge.                                                                                                                                    |
| Behavioral edits to upstream code                                                 | **Keep ours, re-applied on upstream's new version.** Read both sides.                                                                                                                    |
| `docs/**`, `README.md`                                                            | **Keep ours.**                                                                                                                                                                           |
| `README.*.md`, `STATS.md`                                                         | **Keep deleted** (`git rm <file>`).                                                                                                                                                      |
| `bun.lock`                                                                        | Resolve the hunk by hand, prefer upstream's added entries. Never `--theirs`: upstream's lockfile has none of our packages. Do not regenerate unless your `bun` matches `packageManager`. |
| `package.json` (root)                                                             | Merge carefully; prefer upstream versions, re-add our root scripts.                                                                                                                      |
| `.github/workflows/**`                                                            | Keep ours; adopt new upstream workflows.                                                                                                                                                 |

After resolving a sync, run `bun typecheck` from the affected package directories before merging.
A dropped registry line typechecks fine in isolation and fails at runtime.

## Adding a root script

Root `package.json` is upstream-owned. Add harness scripts next to the existing ones and keep the
diff to those lines only:

```jsonc
"dev:harness": "bun --cwd packages/harness dev",
"build:harness": "bun --cwd packages/harness build"
```

## Forbidden changes

- Editing an upstream package when the change belongs in one of ours. Editing upstream code is
  allowed — the inventory above lists where we already do — but every edit is a conflict we pay
  for on every sync, so it needs a reason that a harness-side change cannot serve.
- Editing an upstream package without declaring it in `docs/upstream-inventory.txt` and describing
  it in [What we own inside upstream packages](#what-we-own-inside-upstream-packages), in the same
  pull request. CI enforces the first half; the second is on you. An edit missing from the
  inventory gets silently reverted by the next sync.
- Editing generated files by hand instead of regenerating them.
- Committing directly to `dev`.
- Force-pushing `power` (use `--force-with-lease` only after a rebase you own).
