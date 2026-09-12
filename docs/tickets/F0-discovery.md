# F0 — Discovery

Goal: understand the system and the gap before writing product code.

## F0-1 — TUI ↔ Web parity audit · P0 · done

Produce `docs/PARITY.md` mapping terminal features to web/desktop features and server APIs.

**Acceptance**
- Every TUI slash command, panel/dialog and prompt capability appears in the matrix.
- Each row has a status (parity / partial / missing).
- A gap summary lists the concrete work for F3/F4.

## F0-2 — Server/SDK capability inventory · P0 · done

Cross-check `packages/server` routes and the generated SDK against UI surfaces.

**Acceptance**
- Capabilities used by the TUI are confirmed reachable over HTTP/SSE.
- Any engine capability with no client surface is recorded in PARITY.md.

## F0-3 — Fork bootstrap · P0 · done

Clone the fork, install dependencies, verify the baseline builds.

**Acceptance**
- `bun install` succeeds and the lockfile is unchanged.
- `packages/app` typecheck passes.
- `dev:web` / `dev:desktop` documented in README.

## F0-4 — Initial ADRs · P0 · done

Capture the founding decisions.

**Acceptance**
- ADRs 0001–0008 exist and are linked from ARCHITECTURE.md.
