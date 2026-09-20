# CO — Console org switch (F3-16)

Rama: `console-org`. Objetivo: cerrar F3-16 de verdad.

Estado auditado 2026-09-20: el blocker era falso. El cliente v2 sí tiene
`client.experimental.console.{get,listOrgs,switchOrg}`:
`GET /experimental/console` (org activa + providers gestionados),
`GET /experimental/console/orgs` (orgs con `accountID`/`orgID`) y
`POST /experimental/console/switch`. La UI no los usa.

Reglas de ejecución (acordadas):
1. Un ticket a la vez. Los tickets no se mezclan.
2. Un ticket no se da por cerrado hasta que pasa todas sus pruebas (`bun test` + `bun typecheck` en el paquete tocado, más e2e si aplica).
3. Al cerrar: un commit por ticket, luego se pasa al siguiente.

## Orden

CO-1 → CO-2

---

## CO-1 — Selector de org en providers · P0

**Falta:** sin UI para ver/cambiar la org activa de Console.

**Acceptance**
- `client.console` expone `active()`, `orgs()`, `switchOrg(accountID, orgID)`.
- La sección providers muestra la org activa y, si hay más de una, un selector que cambia y recarga providers.
- Sin Console configurado: la sección no cambia (sin org, sin selector).

**Tests**
- Tipos + caminos donde aplique; `bun test` + `bun typecheck`.

## CO-2 — Verificación y cierre de F3-16 · P1

**Acceptance**
- Matriz: una org (sin selector), varias (cambio efectivo + refetch), sin Console (igual que antes).
- `docs/ROADMAP.md` F3-16 → done con evidencia.

**Tests**
- `bun test` (unit, sin e2e) + `bun typecheck` en verde.
