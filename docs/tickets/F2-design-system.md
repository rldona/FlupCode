# F2 — Design system & shell

Goal: the Claude Code–style harness shell in the web app. See `docs/DESIGN.md`.

## F2-1 — Design tokens + theme layer · P0 · done

`--oh-*` tokens mapped onto `@opencode-ai/ui` theme engine.

**Acceptance**
- Tokens defined for light/dark, mapped in the harness root.
- Light/dark/system switching works; a community theme still applies.
- `prefers-reduced-motion` honoured.

## F2-2 — Window chrome · P0 · done

Traffic lights (desktop), back/forward history, sidebar toggle, search, layout toggle.

**Acceptance**
- Matches the target chrome layout.
- Back/forward works across session navigation.
- Sidebar toggle persists per user.

## F2-3 — Sidebar navigation sections · P0 · done

Nuevo, Artefactos, Rutinas, Personalizar, Rutinas list, Fijado.

**Acceptance**
- Sections render with icons and active states.
- Artefactos/Rutinas/Personalizar route to their screens (can be stubs in F2).

## F2-4 — Sidebar projects · P0 · done

Project list with quick create, pinning, search and filter.

**Acceptance**
- Each project row has quick-create.
- Pin/unpin and filter work and persist.
- Uses existing layout context from `packages/app` where possible.

## F2-5 — Greeting header + home canvas · P0 · done

"¿Qué sigue, <name>?" and the home canvas.

**Acceptance**
- Greeting uses the configured display name.
- Home canvas hosts the dashboard card (F4-1) and composer.

## F2-6 — Composer dock · P0 · done

Context chips, attachments, voice, model/variant/effort, send.

**Acceptance**
- Local / no-folder context chips.
- Attachment tray with paste/drag/drop.
- Model and variant selectors wired to session commands.
- Voice input present (functional in F4-7).

## F2-7 — Sidebar footer profile · P1 · done

Name (editable, persisted), a `Local` plan badge and the About entry point.

**Acceptance**
- Shows account/plan; opens settings.

## F2-8 — Empty states, skeletons, toasts · P1 · done

Consistent feedback across the shell.

**Acceptance**
- Loading, empty and error states for each major surface.
