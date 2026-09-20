# CU — Unified settings (F4-3)

Rama: `unified-settings`. Objetivo: una superficie de ajustes, no 14 modales.

Estado auditado 2026-09-20: `SettingsPanel` ya es rail por secciones; agents vive en
pantalla aparte (`/agents`), MCP tiene dos superficies (sección + modal `McpManager`),
providers vive en modal. Shortcuts ya son editables (H-24) y no entran aquí.

Reglas de ejecución (acordadas):
1. Un ticket a la vez. Los tickets no se mezclan.
2. Un ticket no se da por cerrado hasta que pasa todas sus pruebas (`bun test` + `bun typecheck` en el paquete tocado, más e2e si aplica).
3. Al cerrar: un commit por ticket, luego se pasa al siguiente.

## Orden

CU-1 → CU-2 → CU-3 → CU-4

---

## CU-1 — Agents como sección de Settings · P0

**Falta:** `AgentsPanel` solo vive en la pantalla `/agents` (menú perfil); Settings no tiene sección agents.

**Acceptance**
- Settings tiene sección agents con el `AgentsPanel` completo (archivos, modelos, tools, MCP, guardar/borrar).
- Sección controlable desde fuera (`initialSection` + reset al abrir) para menú perfil y deep-links.
- Menú perfil y `onOpenAgents` abren Settings en agents; la pantalla `/agents` se retira (ruta a home).
- Llaves de recursos (`folderAgents`, `agentFiles`, tools) siguen cargando con la sección abierta.

**Tests**
- `bun test` (unit, sin e2e) + `bun typecheck` en `packages/harness` en verde.

## CU-2 — Una sola superficie MCP · P0

**Falta:** modal `McpManager` duplica la sección mcp de Settings.

**Acceptance**
- Sidebar, comando `/mcp` y perfil abren Settings en mcp; el modal se retira (se mantiene `McpEditor` + helpers y sus tests).
- `mcpOpen` y sus llaves desaparecen o quedan sin uso muerto.

**Tests**
- `McpManager.test.ts` en verde + `bun test` + `bun typecheck`.

## CU-3 — Providers como sección de Settings · P1

**Falta:** `ProvidersPanel` es modal aparte (API keys, OAuth, integraciones).

**Acceptance**
- Contenido extraído a editor reutilizable y montado como sección providers (precedente: `McpEditor`).
- OAuth, unlinked y busy funcionan igual dentro de Settings.
- El modal se retira; sus llamadas abren Settings en providers.

**Tests**
- `bun test` + `bun typecheck` en verde.

## CU-4 — Verificación y cierre de F4-3 · P1

**Acceptance**
- Matriz: cada superficie antigua abre su sección; nada cuelga de pantallas/modales retirados; no quedan señales ni llaves muertas.
- `docs/ROADMAP.md` F4-3 → done con evidencia.

**Tests**
- `bun test` (unit, sin e2e) + `bun typecheck` en verde.
