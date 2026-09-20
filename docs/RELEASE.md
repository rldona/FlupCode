# Release

How FlupCode is versioned and released.

## Versioning

- Semantic versioning: `MAJOR.MINOR.PATCH`, tagged as `flupcode-vX.Y.Z`.
  The `flupcode-` prefix avoids colliding with upstream OpenCode tags.
- The tag is the source of truth. Keep `packages/harness/package.json` and
  `packages/harness-desktop/package.json` versions in sync with the tag.
- The harness **About** dialog shows `packages/harness`'s version.

## What ships

| Artifact | Source | Status |
| --- | --- | --- |
| Web bundle (`flupcode-web.zip`) | `packages/harness/dist` | published by CI |
| Desktop installers | `packages/harness-desktop` | blocked on signing (F5-4) |

## Cutting a release

1. Update the versions:

   ```bash
   # set both package.json versions and commit
   git commit -am "chore: release vX.Y.Z"
   ```

2. Push `power`, then tag and push:

   ```bash
   git tag flupcode-vX.Y.Z
   git push origin flupcode-vX.Y.Z
   ```

3. `.github/workflows/release.yml` runs on the tag: install, typecheck, test, build the harness,
   package `flupcode-web.zip` and create a GitHub Release with generated notes.

4. Verify with:

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

Desktop packaging and auto-update are wired (F5-1…F5-3) but installing on end-user machines requires
code signing and notarization (F5-4, blocked on certificates). Until then, desktop users can run
from source with `dev:harness-desktop`.
