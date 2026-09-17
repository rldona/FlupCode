# Design

The target look is the **Anthropic Claude Code desktop harness**: a calm, neutral, spacious
layout built around projects, a usage dashboard and a persistent composer. This document defines
the direction, the tokens, and the component inventory for `packages/harness`.

## 1. Principles

1. **Calm by default.** Near-monochrome surfaces, hairline borders, restrained accent. The
   conversation and the user's content are the only colourful things on screen.
2. **Project-centric.** The left rail is organized by project/workspace, not by a flat session
   list. Pinning and quick create are first-class.
3. **One composer.** A single, persistent input dock owns the model, effort/variant, attachments,
   voice and context chips.
4. **Glanceable telemetry.** Usage (sessions, messages, tokens, streaks, heatmap) is visible
   without opening a report.
5. **Keyboard-first, mouse-friendly.** Everything reachable from the command palette and keybinds,
   with clear affordances for pointer users.
6. **Quiet motion.** Short, purposeful transitions. No decorative animation.

## 2. Target layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●   [▣]  ←  →                                          [search] [layout]   │  window chrome
├───────────────────┬──────────────────────────────────────────────────────────┤
│  + Nuevo          │                                                          │
│  Artefactos       │              ✳  ¿Qué sigue, Raúl?                        │
│  Rutinas          │                                                          │
│  Personalizar     │      ┌────────────────────────────────────────────┐      │
│                   │      │ Resumen | Modelos        Todo  30d  7d    │      │
│  Rutinas      ›   │      │ [Sesiones][Mensajes][Tokens][Días]        │      │  dashboard card
│                   │      │ [Racha][Racha máx][Hora pico][Modelo fav] │      │
│  Fijado           │      │ ░░░░░░░░░░░░░░░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒     │      │
│   ◦ item          │      └────────────────────────────────────────────┘      │
│   ◦ item          │                                                          │
│                   │                                                          │
│  proyecto-a    +  │                                                          │
│  proyecto-b    +  │                                                          │
│                   │                                                          │
│  RL Raúl · Max ▾  │  [Local] [Sin carpeta]                                   │
│                   │  [ Describe una tarea o haz una pregunta        ] [↵]     │  composer dock
│                   │   +  🎙  Auto                          Opus 5  Medio  ◯   │
└───────────────────┴──────────────────────────────────────────────────────────┘
```

Regions: **window chrome**, **sidebar**, **conversation/home canvas**, **composer dock**.

## 3. Design tokens

Tokens are expressed as CSS custom properties. The harness owns them under the `--fc-*` prefix
(see `packages/harness/src/styles/tokens.css`) and does not render upstream UI components, so a
palette change re-skins the whole app. The `--fc-*` names below are the historical draft that the
`--fc-*` tokens replaced; treat the values as illustrative.

### Colour

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--fc-bg` | `#ffffff` | `#0f0f0f` | App background |
| `--fc-bg-elevated` | `#ffffff` | `#171717` | Cards, popovers |
| `--fc-sidebar` | `#f7f7f7` | `#141414` | Sidebar surface |
| `--fc-border` | `#ececec` | `#262626` | Hairline borders |
| `--fc-text` | `#1a1a1a` | `#f2f2f2` | Primary text |
| `--fc-text-muted` | `#8a8a8a` | `#9a9a9a` | Secondary text |
| `--fc-accent` | `#c96442` | `#d97757` | Brand/terracotta accent |
| `--fc-accent-soft` | `#f4e4dd` | `#2a1c17` | Accent backgrounds |
| `--fc-heat-0..4` | scale | scale | Contribution heatmap |
| `--fc-merged` | `#8250df` | `#a371f7` | A merged pull request |

### Shape & space

| Token | Value |
| --- | --- |
| `--fc-radius-sm` | `8px` |
| `--fc-radius-md` | `12px` |
| `--fc-radius-lg` | `16px` |
| `--fc-space-unit` | `4px` (scale: 4/8/12/16/24/32) |
| `--fc-radius-pill` | `9999px` |
| `--fc-control-sm` | `28px` (compact) |
| `--fc-control-md` | `36px` (default) |
| `--fc-control-lg` | `44px` (composer) |

### Type

| Token | Value |
| --- | --- |
| `--fc-font-ui` | system UI stack |
| `--fc-font-mono` | inherits upstream code font, user-configurable |
| `--fc-text-xs..xl` | `11 / 12 / 13 / 14 / 16 / 20px` |
| Weight | `400` body, `500` labels, `600` headings |

### Keeping it

The names above are the ones in `packages/harness/src/styles/tokens.css`, and `src/tokens.test.ts`
checks that nothing drifts from them:

- a `var(--fc-…)` used without a fallback has to be a token that exists — an invented one is not an
  error, it silently leaves the property at its initial value, which is how `--fc-radius-2`,
  `--fc-radius-3`, `--fc-surface` and `--fc-control-h` gave thirty-two rules square corners and
  controls with no height;
- a radius the system has a name for is not written in pixels;
- every palette sets every colour, or the light one wins in dark mode.

### Elevation & motion

- Elevation: none or a single `0 1px 2px rgb(0 0 0 / 0.04)`; prefer borders over shadows.
- Motion: `120ms` for hover/press, `180ms` for panels, easing `cubic-bezier(0.2, 0, 0, 1)`.
- Respect `prefers-reduced-motion`.

## 4. Component inventory

Built on `@opencode-ai/ui` primitives where possible.

- **Chrome**: `HarnessTitlebar`, `TrafficLights` (desktop), `NavHistory`, `SidebarToggle`.
- **Sidebar**: `SidebarNav`, `SidebarSection`, `ProjectRow`, `PinnedList`, `ProjectFilter`,
  `SidebarFooter` (profile/plan).
- **Home**: `GreetingHeader`, `UsageCard`, `UsageTabs`, `UsageStatGrid`, `ActivityHeatmap`,
  `UsageComparison`.
- **Composer**: `ComposerDock`, `ContextChips`, `ModelSelector`, `VariantEffortSelector`,
  `AutoModeToggle`, `AttachmentTray`, `VoiceInput`, `SendButton`.
- **Conversation**: re-exported from `@opencode-ai/session-ui` (timeline, message parts, diffs,
  tool cards), themed by our tokens.
- **Feedback**: toasts, skeletons, empty states.

## 5. Accessibility

- Minimum contrast 4.5:1 for body text, 3:1 for large text and UI borders.
- Full keyboard operability; visible focus rings using `--fc-accent`.
- Hit targets ≥ `32px`.
- Heatmap and status conveyed by shape/label, not colour alone.

## 6. Theming

Theming has two independent axes, both applied to `<html>`:

- **Mode** (light/dark/system) is the `.fc-dark` class, stored under `flupcode.theme`.
- **Palette** is the `data-fc-theme` attribute, stored under `flupcode.colorTheme`. The FlupCode
  palette (navy/violet, taken from `packages/landing/styles.css`) is the default and has no
  attribute; `data-fc-theme="classic"` selects the original neutral grey/blue palette,
  `data-fc-theme="sublime"` the dark-grey Sublime-style palette, `data-fc-theme="sublime-dark"`
  its deeper, dark-only variant, `data-fc-theme="github"` the Primer-based light/dark pair,
  `data-fc-theme="copilot"` the neutral graphite pair, and `data-fc-theme="vercel"` the Vercel
  dashboard's black dark theme, which is dark-only too.

Each palette normally defines a light and a dark variant (`.fc-dark`), so the two axes multiply.
Palette blocks in `tokens.css` come after `.fc-dark` and must be overridden by a
`[data-fc-theme="…"].fc-dark` block for every token they set. `sublime-dark` and `vercel` are
dark-only: their one block overrides `.fc-dark` in both modes, so they need no
`[data-fc-theme="…"].fc-dark` counterpart.

Settings exposes both axes: **Mode** and **Theme**. `index.html` applies the saved pair before the
first paint to avoid a flash, so its background colours are duplicated there by design and must stay
in sync with `--fc-bg`.
