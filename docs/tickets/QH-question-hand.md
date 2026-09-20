# QH — Mano amarilla en pregunta pendiente

Rama: `question-hand`. Objetivo: cuando un agente pregunta con opciones, la sesión
muestra 👋 amarilla en vez del punto, indicando que espera respuesta.

Estado auditado: `blockedSessions()` ya incluye preguntas (punto naranja compartido
con permisos). Hay que distinguirlas.

## QH-1 — Distinguir pregunta y pintar la mano · P0

**Acceptance**
- `questionSessions()` deriva sesiones con preguntas accionables de `blocked().data`
  (entradas con `questions` no vacío; permisos no lo tienen).
- Sidebar: mano amarilla 👋 con "Waiting for answer" en vez del punto; prioridad sobre
  corriendo y sobre permiso (si hay pregunta, manda la mano).
- Sin preguntas: todo igual que antes.

**Tests**
- `pending-questions.test.ts` + `bun typecheck` + suite unit en verde.
