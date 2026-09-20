# TN — Serve/tunnel in-app (F6-4)

Rama: `tunnel-share`. Objetivo: cerrar F6-4 de verdad.

Estado auditado 2026-09-20: el panel Remote muestra QR + URL con copiar y el comando
LAN como texto estático. No hay comando de túnel, ni copiar en los comandos, ni estado
de conexión. F8 (relay) cubre lo remoto; esto es la vía "sin relay".

Reglas de ejecución (acordadas):
1. Un ticket a la vez. Los tickets no se mezclan.
2. Un ticket no se da por cerrado hasta que pasa todas sus pruebas (`bun test` + `bun typecheck` en el paquete tocado, más e2e si aplica).
3. Al cerrar: un commit por ticket, luego se pasa al siguiente.

## Orden

TN-1 → TN-2 → TN-3

---

## TN-1 — Comandos copiables: LAN + túnel · P0

**Falta:** el comando LAN es texto fijo (`--port 4096`, sin CORS del origen actual);
no existe comando de túnel.

**Acceptance**
- Comando LAN con puerto real y `--cors <origen actual>`, con botón copiar.
- Comando `cloudflared tunnel --url http://localhost:<puerto>`, con botón copiar.
- Helpers puros para construir ambos comandos.

**Tests**
- `RemotePanel.test.ts` (o suite nueva): comandos con puerto/CORS/origen; `bun typecheck`.

## TN-2 — Estado de la URL local · P1

**Falta:** nada dice si la URL responde.

**Acceptance**
- La URL del panel muestra estado (reachable / blocked / offline) vía `probeServer`, con debounce.
- No dispara probes en bucle: solo al abrir y al editar la URL.

**Tests**
- Lógica de estado donde sea testeable + `bun typecheck`.

## TN-3 — Verificación y cierre de F6-4 · P1

**Acceptance**
- Matriz: QR, copiar URL, copiar LAN, copiar túnel, estado.
- `docs/ROADMAP.md` F6-4 → done con evidencia.

**Tests**
- `bun test` (unit, sin e2e) + `bun typecheck` en verde.
