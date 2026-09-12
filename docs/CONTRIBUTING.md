# Contributing

Thanks for helping build OpenHarness. This project is a fork of OpenCode; read
[docs/UPSTREAM.md](UPSTREAM.md) first, because the upstream boundary shapes how we work.

## Getting started

```bash
# clone your fork, then:
git remote add upstream https://github.com/anomalyco/opencode.git
bun install
bun run dev:harness
```

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

## Reporting issues

Tag issues with the phase/ticket they relate to. For upstream bugs that also affect OpenCode,
report them upstream and note the cross-reference here.
