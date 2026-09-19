# HF — High features a 100%

Rama: `high-features`. Objetivo: dejar Workflows, Runs, Artifacts y Routines al 100% funcional y técnico.

Reglas de ejecución (acordadas):
1. Un ticket a la vez. Los tickets no se mezclan.
2. Un ticket no se da por cerrado hasta que pasa todas sus pruebas (`bun test` + `bun typecheck` en el paquete tocado, más e2e si aplica).
3. Al cerrar: un commit por ticket (`feat(harness): ...`), luego se pasa al siguiente.
4. Base actual verificada: `harness-server@1.13.8` (runs/workflows/routines/artifacts corriendo en servidor, no en navegador).

## Orden

HF-1 → HF-2 → HF-3 → HF-4 → HF-5 → HF-6 → HF-7 → HF-8

---

## HF-1 — Workflows: lanzamiento y reanudación · P0

**Falta:** lanzar desde composer (`/feature …`), paleta y botón de proyecto; "ejecutar hasta tarea X"; "reanudar desde checkpoint".

**Acceptance**
- `/feature <goal>` + paleta + botón lanzan el workflow con sus `inputs`.
- Existe "run until task X" y "resume from checkpoint" sin duplicar tareas.
- 409/400 con mensajes accionables (input faltante, workflow desconocido).

**Tests**
- `packages/harness-server/src/workflow.test.ts`: until-X y resume no duplican `sessionID`/`messageID`.
- e2e `packages/harness/e2e/workflows.spec.ts` en verde.

## HF-2 — Workflows: plantillas y validación · P0

**Falta:** plantillas `bugfix` (investigate→reproduce→fix→verify→review), `refactor`, `review` como ficheros; `inputs` con tipos/defaults; errores YAML por línea; diff antes de guardar.

**Acceptance**
- Las 4 plantillas existen en `~/.local/share/flupcode/workflows` y `.flupcode/workflows/` las sobreescribe.
- Editor muestra error por línea y diff previo; guardar inválido es rechazado.

**Tests**
- `workflow.test.ts`: plantillas parsean y proyecto gana a global; validación rechaza YAML roto.
- e2e editor en verde.

## HF-3 — Workflows: semántica DAG · P1

**Falta:** `when` sobre veredictos estructurados (`format: json_schema`), fan-out visible con tope, `workspace: worktree` por defecto en escritura paralela.

**Acceptance**
- `when` salta tarea según veredicto real del `verify`, no por texto libre.
- Paralelas respetan `RUN_CONCURRENCY=4` y la UI lo muestra; tareas de escritura usan worktree sin pedirse.

**Tests**
- `workflow.test.ts` + `runner` (tasks): when/parallel/foreach cubiertos; worktree por tarea con merge y cleanup (H-29).

## HF-4 — Runs: supervisión · P0

**Falta:** vista Run árbol + timeline/gantt con acciones por tarea (steer/retry/cancel/approve) y estado (modelo, tokens/coste, tool actual, bloqueo).

**Acceptance**
- Cada tarea muestra estado, agente/modelo, duración, coste, archivos, tool actual y bloqueo con acción inline.
- steer/retry/cancel/approve funcionan desde la vista y desde móvil estrecho.

**Tests**
- `api.test.ts` (`runs/:id/stop|approve`, retry como tarea nueva) + e2e runs en verde. Sin refetch completo por evento.

## HF-5 — Runs: recuperación, comparativa y presupuesto · P1

**Falta:** reanudar tras reinicio desde última tarea completa; comparar 2 runs; replay; deep links `/run/:id`; pausa por presupuesto con confirmación; watchdog `stalled`.

**Acceptance**
- Al arrancar, runs `running` se reanudan o marcan `interrupted` con acción "reanudar", sin repetir trabajo (idempotencia por `sessionID`/`messageID`).
- Comparativa tokens/coste/diff/veredicto; deep link abre el run; presupuesto pausa y pide confirmación (push al móvil); `stalled` notifica y ofrece interrupt+retry.

**Tests**
- `runner`/`repository` recovery + `compare`/`replay` (H-33) en verde; `policy` budget en verde.

## HF-6 — Artifacts: registro automático · P1

**Falta:** auto-registro de `plans/*.md`, handoffs y veredictos ligados a run/tarea; `@artifact:` también en móvil.

**Acceptance**
- Todo run deja `report`; todo `verify` deja `verdict`; handoff entre tareas es artifact citable.
- `@artifact:` funciona en composer desktop y móvil.

**Tests**
- `artifacts.test.ts` + `plans.test.ts` en verde; SSE publica al escribirse.

## HF-7 — Artifacts: índice y retención · P2

**Falta:** búsqueda por proyecto/run/kind, pins, retención/límites, export/share MD/JSON, kinds `screenshot`/`handoff` de primera clase.

**Acceptance**
- `GET /harness/artifacts?directory=&runID=&kind=` + búsqueda; pin; export MD con opciones y JSON; retención documentada.

**Tests**
- `artifacts.test.ts` (filtro, techo inline, hash, delete) en verde.

## HF-8 — Routines: notify, policy y limpieza · P0

**Falta:** `policy` por rutina, `notify` con push + enlace al Run, pausa global, logs, alerta de fallos repetidos, timezones, import/export, borrar camino legacy `setInterval` en cliente.

**Acceptance**
- Rutina = `{workflow|prompt, project, schedule, policy, notify}`; cada ejecución es un Run normal supervisado.
- Push al móvil con enlace; 409 si ya corre (lock+lease); recovery de huérfanos; sin `setInterval` en `app.tsx`.

**Tests**
- `schedule.test.ts` + `scheduler` (lock, lease, recovery, run-now, enable/disable) en verde; e2e routines en verde.
