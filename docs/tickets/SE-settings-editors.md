# SE — Settings editors (F3-13)

Rama: `settings-editors`. Objetivo: cerrar F3-13 de verdad.

Estado auditado 2026-09-20: los 4 editores existen y están cableados
(`AgentsPanel`, `CommandsPanel`+variant/subtask, `McpEditor` local/remoto,
`PermissionsPanel` acciones planas). Quedan 2 gaps + verificación.

Reglas de ejecución (acordadas):
1. Un ticket a la vez. Los tickets no se mezclan.
2. Un ticket no se da por cerrado hasta que pasa todas sus pruebas (`bun test` + `bun typecheck` en el paquete tocado, más e2e si aplica).
3. Al cerrar: un commit por ticket, luego se pasa al siguiente.

## Orden

SE-1 → SE-2 → SE-3

---

## SE-1 — Permissions: editor de reglas con patrones · P0

**Falta:** `PermissionsPanel` edita acciones planas; los mapas por patrón
(`bash: { "rm -rf *": "deny" }`) se apartan y se escriben intactos. No hay forma
de crear/editar una regla con patrón desde la UI (PARITY §5: rule editor ❌).

**Acceptance**
- Crear/editar/borrar reglas `{ tool, pattern, allow|ask|deny }` por herramienta.
- `external_directory` siempre visible como `ask` mínimo.
- Round-trip: lo que el form no entiende se conserva byte a byte (como hoy).
- Validación: patrón vacío o herramienta desconocida no se guarda.

**Tests**
- `PermissionsPanel.test.ts`: parse/serializa reglas con patrones; round-trip con mapas desconocidos.

## SE-2 — MCP: flujo OAuth en el manager · P1

**Falta:** `McpEditor` añade local/remoto, conecta/desconecta; el OAuth del engine
(`GET /mcp/:name/auth` → start, `/callback`, `/authenticate`) no se usa desde la UI.

**Acceptance**
- Servidor con estado `needs auth` muestra "Connect with OAuth"; abre el flujo y refleja el estado al volver.
- `client.mcp` expone `authStart/authCallback/authenticate/remove`.
- Sin OAuth (server local) nada cambia.

**Tests**
- `client` o panel-level donde aplique; e2e si hay harness disponible. Mínimo: tipos + caminos 200/404/409 del flujo contra el SDK generado.

## SE-3 — Verificación y cierre de F3-13 · P1

**Falta:** dar F3-13 por hecho con evidencia por editor.

**Acceptance**
- Matriz: agents / commands / mcp / permissions — leer, editar, guardar, recargar; defaults del engine respetados.
- `docs/ROADMAP.md` F3-13 → done con evidencia; `docs/tickets/F3-parity.md` F3-13 ya dice done (mantener).

**Tests**
- `bun test` (unit, sin e2e) + `bun typecheck` en `packages/harness` en verde.
