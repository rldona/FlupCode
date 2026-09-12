# ADR-0003: Design system

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

The target is the Anthropic Claude Code desktop harness: calm neutral surfaces, a project-centric
sidebar, a usage dashboard and a persistent composer. OpenCode already has a theme engine and a UI
primitive library (`@opencode-ai/ui`), and users can install community themes.

## Decision

- Define FlupCode design tokens as CSS custom properties (`--oh-*`) documented in
  [DESIGN.md](../DESIGN.md).
- Map those tokens onto the upstream theme engine so light/dark/system switching and community
  themes keep working.
- Build the harness components on `@opencode-ai/ui` primitives and Tailwind v4, matching upstream's
  stack (SolidJS, Kobalte) to maximise reuse and contributor familiarity.
- Keep motion short and purposeful; honour `prefers-reduced-motion`.

## Consequences

- A single token layer drives the Claude Code–style look without forking the theme engine.
- Community themes remain installable; our tokens are the fallback layer.
- Design changes are reviewed against DESIGN.md and the parity matrix.
