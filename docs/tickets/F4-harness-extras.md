# F4 — Harness extras

Goal: the features in the target screenshot that go beyond TUI parity.

## F4-1 — Global usage dashboard · P1 · done

Summary/Models tabs with ranges (all / 30d / 7d): sessions, messages, total tokens, active days,
current streak, longest streak, peak hour, favorite model.

**Acceptance**
- Metrics computed from local session/message data.
- Range switching re-computes.
- Model tab breaks usage down by model.

## F4-2 — Multi-project workspaces + pinned items · P1 · doing

**Acceptance**
- Projects and workspaces are first-class in the sidebar.
- Pinned items persist and are reorderable.

## F4-3 — Unified "Personalizar" · P1 · done

**Acceptance**
- One surface for appearance, models, agents, permissions, commands, MCP and shortcuts.

## F4-4 — Activity heatmap + comparisons · P2 · done

**Acceptance**
- Contribution-style heatmap over a rolling year.
- Fun comparison line ("used ~N× more tokens than …").

## F4-5 — Artifacts · P2 · todo

**Acceptance**
- Generated/collected artifacts are listed and openable.
- Scoping model documented.

## F4-6 — Routines (scheduled tasks) · P2 · done

**Acceptance**
- Create/list/edit/disable routines.
- Runs execute through the engine and surface results.

## F4-7 — Voice input · P2 · done

**Acceptance**
- Dictation into the composer with a clear on/off state and permission handling.

## F4-8 — In-place message editing · P2 · done

**Acceptance**
- Edit a sent user message and re-run, with revert fallback.
