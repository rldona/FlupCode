# ADR-0006: Definition of parity

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

"Bring everything the TUI has to the UI" needs a concrete, testable definition, otherwise the
project never converges. The F0 audit found that the web/desktop UI already covers the large
majority of terminal features via the shared server API, with a small set of genuine gaps.

## Decision

- Parity is defined by the matrix in [PARITY.md](../PARITY.md).
- A feature is at **parity** when a user can accomplish the same task in the harness web UI as in
  the TUI, using the same engine capabilities, with equivalent outcomes.
- Parity is **task-level**, not keyboard-level: identical keybindings are not required, but every
  command/action must be reachable (command palette at minimum).
- The matrix is the acceptance gate for phase F3. F4 (extras) starts only when all P0/P1 parity
  rows are `✅` or explicitly deferred with a rationale.

## Consequences

- Objective progress tracking and a clear finish line for M1.
- Features that are terminal-specific by nature (e.g. leader-key semantics, terminal suspend) are
  not required verbatim; their user goal must still be reachable.
- Any deferral is recorded in the matrix with a reason.
