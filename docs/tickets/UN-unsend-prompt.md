# UN — Unsend prompt (recuperar lo enviado)

Rama: `unsend-prompt`. Objetivo: recuperar un prompt recién enviado y parar el turno,
solo mientras el agente no ha hecho nada irreversible.

Estado auditado 2026-09-20: existe Stop (abort), Edit (revert+refill) y Retry; no hay
"unsend". El engine tiene `DELETE /session/:id/message/:messageID` (`session.removeMessage`,
store legacy) pero exige sesión idle: hay que abortar y esperar primero.

Reglas de ejecución (acordadas):
1. Un ticket a la vez. Los tickets no se mezclan.
2. Un ticket no se da por cerrado hasta que pasa todas sus pruebas (`bun test` + `bun typecheck` en el paquete tocado, más e2e si aplica).
3. Al cerrar: un commit por ticket, luego se pasa al siguiente.

## Orden

UN-1 → UN-2

---

## UN-1 — Recuperar el último prompt si no hay tools · P0

**Falta:** botón Recuperar en el mensaje enviado.

**Acceptance**
- Elegible solo si: es el último mensaje de usuario, sin asistente detrás y sin tool-calls detrás.
- Acción: texto de vuelta al composer primero (nunca se pierde), abort, espera a idle (timeout 10s), borra el mensaje.
- Si el borrado falla (carrera), el texto ya está recuperado: toast informativo, sin reescribir historia.
- Sin revert de ficheros: por definición aún no hay cambios.

**Tests**
- `unsend.test.ts`: elegibilidad (último/no herramientas/respuesta detrás/steer) + `bun typecheck`.

## UN-2 — Verificación y bordes · P1

**Falta:** matriz de bordes.

**Acceptance**
- Turno con texto en streaming: recuperable; con tool en vuelo: no.
- Segunda prompt en cola (steer/queue): cada una se evalúa contra lo ocurrido desde ella.
- Móvil: misma acción en el mensaje.

**Tests**
- `bun test` (unit, sin e2e) + `bun typecheck` en verde.
