# ADR-0001: Fork and upstream synchronisation

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

FlupCode is built as a GitHub fork of `anomalyco/opencode`. We want to keep consuming upstream
improvements (providers, tools, engine fixes) without a permanent divergence that becomes
unmaintainable. Upstream moves fast and owns most of the monorepo.

## Decision

- Fork `anomalyco/opencode` as `rldona/FlupCode`.
- Keep two long-lived branches:
  - `dev` — a **fast-forward-only mirror** of `upstream/dev`. Never commit here.
  - `power` — the product branch and default branch.
- Never edit upstream packages. Product code lives in `packages/harness` and
  `packages/harness-desktop`.
- Automate syncing with a scheduled GitHub Action that fast-forwards `dev` and opens a `dev → power`
  pull request.

## Consequences

- Upstream merges are usually clean; conflicts are confined to FlupCode-owned files.
- We accept a periodic review PR to stay current.
- Renaming or restructuring upstream packages is off the table; we adapt in `harness`.
- See [UPSTREAM.md](../UPSTREAM.md) for the operational workflow.
