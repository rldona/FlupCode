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
palette change re-skins the whole app. The `--oh-*` names below are the historical draft that the
`--fc-*` tokens replaced; treat the values as illustrative.

### Colour

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--oh-bg` | `#ffffff` | `#0f0f0f` | App background |
| `--oh-bg-elevated` | `#ffffff` | `#171717` | Cards, popovers |
| `--oh-sidebar` | `#f7f7f7` | `#141414` | Sidebar surface |
| `--oh-border` | `#ececec` | `#262626` | Hairline borders |
| `--oh-text` | `#1a1a1a` | `#f2f2f2` | Primary text |
| `--oh-text-muted` | `#8a8a8a` | `#9a9a9a` | Secondary text |
| `--oh-accent` | `#c96442` | `#d97757` | Brand/terracotta accent |
| `--oh-accent-soft` | `#f4e4dd` | `#2a1c17` | Accent backgrounds |
| `--oh-heat-0..4` | scale | scale | Contribution heatmap |

### Shape & space

| Token | Value |
| --- | --- |
| `--oh-radius-sm` | `8px` |
| `--oh-radius-md` | `12px` |
| `--oh-radius-lg` | `16px` |
| `--oh-space-unit` | `4px` (scale: 4/8/12/16/24/32) |
| `--oh-control-h` | `32px` (compact), `36px` (default) |

### Type

| Token | Value |
| --- | --- |
| `--oh-font-ui` | system UI stack |
| `--oh-font-mono` | inherits upstream code font, user-configurable |
| `--oh-text-xs..xl` | `11 / 12 / 13 / 14 / 16 / 20px` |
| Weight | `400` body, `500` labels, `600` headings |

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
- Full keyboard operability; visible focus rings using `--oh-accent`.
- Hit targets ≥ `32px`.
- Heatmap and status conveyed by shape/label, not colour alone.

## 6. Theming

Theming has two independent axes, both applied to `<html>`:

- **Mode** (light/dark/system) is the `.fc-dark` class, stored under `flupcode.theme`.
- **Palette** is the `data-fc-theme` attribute, stored under `flupcode.colorTheme`. The default
  palette has no attribute; `data-fc-theme="landing"` selects the navy/violet palette taken from
  `packages/landing/styles.css`.

Each palette defines a light and a dark variant (`.fc-dark`), so the two axes multiply. Palette
blocks in `tokens.css` come after `.fc-dark` and must be overridden by a
`[data-fc-theme="…"].fc-dark` block for every token they set.

Settings exposes both axes: **Mode** and **Theme**. `index.html` applies the saved pair before the
first paint to avoid a flash, so its background colours are duplicated there by design and must stay
in sync with `--fc-bg`.
