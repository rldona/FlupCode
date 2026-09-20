# SK — Skill manager (F3-10)

Rama: `skill-manager`. Objetivo: cerrar F3-10 de verdad.

Estado auditado 2026-09-20: `SkillCatalogue` cubre ficheros, orígenes (paths/urls),
diagnósticos (loaded/reason/shadows) y crear/editar/borrar; el `/` ya lista skills.
Quedan visibilidad por agente y distintivos de origen en el composer.

Reglas de ejecución (acordadas):
1. Un ticket a la vez. Los tickets no se mezclan.
2. Un ticket no se da por cerrado hasta que pasa todas sus pruebas (`bun test` + `bun typecheck` en el paquete tocado, más e2e si aplica).
3. Al cerrar: un commit por ticket, luego se pasa al siguiente.

## Orden

SK-1 → SK-2 → SK-3

---

## SK-1 — Visibilidad por agente en el catálogo · P0

**Falta:** el catálogo no dice qué agentes ven cada skill (MCP sí lo dice vía `mcp-access`).

**Acceptance**
- Cada skill muestra los agentes que la permiten, con la misma regla del engine sobre el `tools` map (`skill`/`skill_<name>`/`*`).
- Regla en `skill-access.ts` con tests; fila en el catálogo; `agents` cableado desde app.

**Tests**
- `skill-access.test.ts` (wildcard, prefijo, negación, sin mapa) + `bun typecheck`.

## SK-2 — Distintivos de origen en el `/` · P1

**Falta:** skills, comandos y workflows salen en el `/` sin decir qué son.

**Acceptance**
- `CommandOption.source` (`builtin`/`command`/`skill`/`workflow`); el menú lo pinta como distintivo en desktop y móvil.
- `commandOptions()` etiqueta cada origen.

**Tests**
- `composer-menus.test.ts` o suite del menú donde aplique + `bun typecheck`.

## SK-3 — Verificación y cierre de F3-10 · P1

**Acceptance**
- Matriz: catálogo (orígenes, diagnósticos, visibilidad, CRUD), `/` con distintivos, invocar skill vía prompt.
- `docs/ROADMAP.md` F3-10 → done con evidencia.

**Tests**
- `bun test` (unit, sin e2e) + `bun typecheck` en verde.
