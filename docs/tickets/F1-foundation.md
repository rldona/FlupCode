# F1 — Foundation & upstream

Goal: a maintainable fork that can absorb upstream changes without pain.

## F1-1 — Fork, remotes, branch model · P0 · done

`dev` mirrors `upstream/dev`; `power` is the product branch.

**Acceptance**
- `origin` and `upstream` configured.
- `dev` tracks `upstream/dev`; `power` created from it.
- Branch model documented in UPSTREAM.md.

## F1-2 — `upstream-sync` GitHub Action · P0 · done

Scheduled workflow that fast-forwards `dev` and opens a `dev → power` PR.

**Acceptance**
- Runs on cron + `workflow_dispatch`.
- Fails safely if `dev` diverges (does not force-push silently).
- Opens or updates a PR with a generated summary.
- PR runs typecheck + harness build.

## F1-3 — Rebrand · P0 · doing

Product identity across harness surfaces, with non-affiliation notice.

**Acceptance**
- App name, icon, about dialog and window title read "OpenHarness".
- README and app footer state non-affiliation with OpenCode and Anthropic.
- Upstream LICENSE untouched.

## F1-4 — Base docs · P0 · done

README, ARCHITECTURE, UPSTREAM, DESIGN, PARITY, ROADMAP, CONTRIBUTING, ADRs, tickets.

**Acceptance**
- All documents exist and cross-link.
- ROADMAP and PARITY are the tracking sources of truth.

## F1-5 — Product build/release pipeline · P1 · todo

CI to build/release the harness (and later desktop).

**Acceptance**
- CI builds `packages/harness` on PR and on tag.
- Artifacts published; versioning scheme documented.

## F1-6 — Set `power` as default branch · P1 · done

`gh repo edit rldona/OpenHarness --default-branch power`.

**Acceptance**
- Fork default branch is `power`.
- New clones land on `power`.
