# Release

How FlupCode is versioned and released.

## Versioning

- Semantic versioning: `MAJOR.MINOR.PATCH`, tagged as `flupcode-vX.Y.Z`.
  The `flupcode-` prefix avoids colliding with upstream OpenCode tags.
- The tag is the source of truth. Keep `packages/harness/package.json` and
  `packages/harness-desktop/package.json` versions in sync with the tag.
- The harness **About** dialog shows `packages/harness`'s version.
- `harness-server` is private and published as no artifact of its own, but it is compiled into the
  desktop app as an extra resource, so it ships with every release and is versioned with the rest.
  It joined at 1.8.0, having drifted to 1.2.0 while it was unreleased.

## What ships

| Artifact | Source | Status |
| --- | --- | --- |
| Web bundle (`flupcode-web.zip`) | `packages/harness/dist` | published by CI |
| Desktop installers (unsigned) | `packages/harness-desktop` | published by CI; signing blocked (F5-4) |
| `flupcode` CLI binaries | `packages/flupcode-cli` | published by CI |

## Cutting a release

1. Update the versions (`harness`, `harness-desktop`, `harness-server`, `remote`, `relay`,
   `flupcode-cli`) and the
   lockfile on a branch, and open a pull request: `power` is protected, so nothing is pushed to it
   directly.

   ```bash
   git switch -c release-X.Y.Z origin/power
   # set the six package.json versions, then:
   npm_config_registry="https://registry.npmjs.org/" bun install
   git commit -am "chore: bump version to X.Y.Z"
   git push -u origin release-X.Y.Z
   gh pr create --base power --title "chore: bump version to X.Y.Z"
   ```

2. Once CI is green, merge it with rebase, then tag the merged commit on `origin/power` (never a
   local commit) and push the tag:

   ```bash
   gh pr merge <number> --rebase
   git fetch origin
   git tag flupcode-vX.Y.Z origin/power
   git push origin flupcode-vX.Y.Z
   ```

   Stop at the first failure (for example with `set -eo pipefail` in a script): a tag pushed after
   a rejected push starts a release from a commit that is not on `power`.

3. `.github/workflows/release.yml` runs on the tag. It opens the release **as a draft**, and then each
   job builds and publishes its own part of it, in parallel: the web bundle, the five `flupcode` CLI
   binaries, and the desktop installers per platform. A `verify` job reads the update manifests
   (`latest*.yml`) off the draft and fails if any file they name is not an asset, and only then is the
   draft published (`--latest`).

   Nothing is read back from the Actions artifact store to publish it, and no job waits on another's
   upload, so a release takes about six minutes — the Windows installer is the long part. When
   GitHub's asset endpoint is slow for a file, only that platform's job waits. A release that fails
   halfway stays a draft, so `releases/latest` keeps serving the previous one; fix the cause and
   `gh run rerun <run-id> --failed` re-publishes over the same assets (`--clobber`).

4. Add a short user-facing summary above the generated notes (what changed, how to update, and
   the unsigned-build note for macOS):

   ```bash
   gh release edit flupcode-vX.Y.Z --notes-file notes.md
   ```

   The web app (`app.flupcode.com`) and the landing deploy from `power` on merge, independently of
   releases (see "Merging" and "Deploys" in [CONTRIBUTING.md](CONTRIBUTING.md)).

5. Verify with:

   ```bash
   gh release view flupcode-vX.Y.Z
   ```

## Manual fallback

```bash
bun install
bun run --cwd packages/harness typecheck
bun run --cwd packages/harness test
bun run --cwd packages/harness build
(cd packages/harness/dist && zip -r ../../../flupcode-web.zip .)
gh release create flupcode-vX.Y.Z flupcode-web.zip --title "FlupCode vX.Y.Z" --generate-notes
```

## Desktop

Installers are published on every release and the app auto-updates from GitHub Releases
(`electron-updater`). They are **not signed or notarized** (F5-4, blocked on Apple and Windows
certificates): macOS shows "FlupCode Not Opened" and needs **Open Anyway** or removing the quarantine
flag, and Windows shows SmartScreen. See [USAGE.md](USAGE.md#installing-a-release).
