# WA — Web actions (publicar y actuar en una web)

Rama: `web-actions`. Objetivo: que el agente pueda actuar sobre una web real (navegar, rellenar,
subir, enviar, leer) con aprobación por acción, credenciales aisladas y evidencia, **declarado como
configuración** (`flupcode.actions`) para que cualquier usuario lo use con cualquier sitio. El caso
real (un sitio concreto y una pieza concreta) es un perfil, no código.

Documentos de referencia: [ADR-0015](../adr/0015-web-actions-and-browser-automation.md) y
[WEB-ACTIONS.md](../WEB-ACTIONS.md).

Reglas de ejecución (acordadas):

1. Un ticket a la vez. Los tickets no se mezclan.
2. Un ticket no se da por cerrado hasta que pasa todas sus pruebas (`bun test` + `bun typecheck` en el
   paquete tocado, más e2e si aplica).
3. Al cerrar: un commit por ticket (`feat(harness-server): ...`), luego se pasa al siguiente.
4. Nada toca los paquetes upstream (ADR-0001/0002). Todo vive en `harness-server`, `remote`, `harness`
   y `harness-desktop`.
5. Regla de config: **una clave top-level por medio/backend; un perfil por caso de uso.** El SO nativo
   será `flupcode.os`, nunca un perfil dentro de `actions`.

## Orden

PoC: WA-0 → WA-1 → WA-2 → WA-3 → WA-4 → WA-5 → WA-6 → WA-7 → WA-8 → WA-10.

WA-9 es **bloqueante de release**, no del PoC (el PoC corre en desarrollo con el motor local).

---

## WA-0 — Contrato y documentación · P0

**Falta:** el ADR y el contrato existen y fijan la regla; el roadmap apunta a esta fase.

**Acceptance**

- `docs/adr/0015-web-actions-and-browser-automation.md` (Proposed) y `docs/WEB-ACTIONS.md` existen.
- `docs/ROADMAP.md` tiene el milestone **M7 Web actions** (F9) y enlaza al ticket.
- La regla "una clave por medio, un perfil por caso de uso" está escrita en ADR y contrato, y
  `flupcode.os` queda reservado.
- Ningún nombre de producto aparece en los documentos.

**Tests**

- `bun run repo-hygiene` en verde.
- Revisión de los tres documentos.

## WA-1 — Runtime de navegador y frontera · P0

**Falta:** un runtime Playwright en `harness-server`, con perfil Chromium persistente por proyecto,
headed/headless según contexto, sus rutas, su autenticación y el guard de egress. **Sin exponer
todavía ninguna tool al modelo.**

**Acceptance**

- `browser.ts` lanza Chromium gestionado con `userDataDir` por proyecto; `headed` en sesión
  interactiva, `headless` en routines (parámetro por sesión).
- Rutas `/harness/browser/*` (start/session/navigate/snapshot/click/type/submit/frame/close) con
  **bearer token** de loopback (`0600`) y cabecera `x-flupcode-session`.
- Egress/SSRF: `file:`, `data:`, loopback, link-local, RFC1918, `::1` y `169.254.169.254` se rechazan
  con `403 navigation_blocked`; una URL pública pasa.
- Cada captura se registra como artefacto `kind: "screenshot"` y se sirve por
  `GET /harness/artifacts/:id/raw`; `GET .../frame` devuelve el último PNG.
- `capabilities.ts` anuncia `browser`; el runtime se construye en `index.ts` y se detiene en `stop()`.

**Tests**

- `packages/harness-server/src/browser.test.ts`: token ausente → 403; SSRF bloqueado; navigate/snapshot/
  click contra un `Bun.serve` fixture; artefacto recuperable en `/raw`.
- `bun test` + `bun typecheck` en `packages/harness-server`.

## WA-2 — Motor de acciones (recetas) · P0

**Falta:** el esquema `flupcode.actions` y el runner determinista con evidencia.

**Acceptance**

- Sobre válido: `tool, description, kind, origin, credential, inputs, steps, extract, guards,
sensitive, availability, evidence`; `kind` no soportado se rechaza al cargar.
- Gramática web de pasos: `goto, waitFor, fill, click, upload, submit, assert, screenshot`; `extract`.
- Runner determinista: timeout por paso, reintentos acotados, evidencia por paso (screenshot),
  fail-closed. El agente no improvisa la secuencia.
- `inputs` (`text/alt/image`) accesibles por `{{name}}`; imagen del compose/artefacto materializada a
  fichero temporal para `setInputFiles`; `credential` inyectada por nombre y nunca devuelta.
- Guards reutilizados (mismo contrato que delivery), fail-closed.

**Tests**

- `actions.test.ts`: acción `do` y acción `read` contra fixture; un paso que falla devuelve error
  estructurado + evidencia; un guard que deniega aborta; `extract` devuelve valores.
- `bun test` + `bun typecheck` en `packages/harness-server`.

## WA-3 — Plugin de tools y aprobación · P0

**Falta:** el plugin de motor que expone una tool por perfil y pide aprobación.

**Acceptance**

- `WEB_ACTIONS_PLUGIN` (plain-JS, sin imports de terceros, fichero generado `flupcode-actions.js`) registra **una tool por perfil**, como
  `DELIVERY_PLUGIN`; lee perfiles de `flupcode.actions` y el token del fichero de loopback.
- Aprobación **pre-flight única por acción**, no un `ctx.ask` antes de cada paso: `ctx.ask({permission:
  "browser_sensitive", patterns, always, metadata})` con recurso `origin:action` y los pasos con
  efectos a la vista; `browser` cubre navegar y leer. El `always` recuerda como máximo `origin` o
  `origin:action`.
- Devuelve resumen de texto, screenshot y artefacto de evidencia.
- Con `FLUPCODE_BROWSER_DISABLED=1` no registra tools de navegador (kill switch).

**Tests**

- `packages/remote/src/engine-plugins.test.ts`: el plugin se genera y parsea; con deny no se emite
  ninguna llamada HTTP a `harness-server`; con ask aparece la petición (integración con fixture).
- `bun test` + `bun typecheck` en `packages/remote`.

## WA-4 — Permisos y UI de sesión · P0

**Falta:** reglas de permiso y superficies que explican qué va a pasar.

**Acceptance**

- `browser`/`browser_sensitive` quedan cubiertos por el `*: ask` de `manual`/`accept-edits` y por el
  default del motor en `auto`; se actualiza la descripción de `bypass` para incluir el navegador.
- `permission-preview.ts` gana un kind `browser` (origin, acción, perfil, screenshot); el
  `PermissionDock` muestra el alcance del "siempre" (`origin` / `origin:action`).
- `SessionView` pinta las tools `browser_*`/`do_*`/`read_*` con pasos y screenshots inline.
- Claves ES añadidas en `i18n.ts`.

**Tests**

- `permission-preview` y `alwaysScope` con tests; `i18n.test.ts` sin claves ES duplicadas.
- `bun test` + `bun typecheck` en `packages/harness`.

## WA-5 — Credenciales, perfiles y redacción · P0

**Falta:** login aislado y secretos fuera del transcript.

**Acceptance**

- Vault cifrado (store en `harness-server`, clave desde `safeStorage` del desktop; fallback `0600` en
  macOS como `remote.json`). Alta/baja por nombre; nunca se devuelve el valor.
- Login manual una vez en el perfil aislado del proyecto; cookies persistentes; "borrar datos".
- Redacción en captura: `input[type=password]`, `[autocomplete^=cc-]` y campos rellenados; stripping de
  valores en snapshots; binding por origen (una credencial no se inyecta fuera de su origen).

**Tests**

- Tras `type` con credencial, el resultado de la tool, el transcript, el snapshot y los artefactos no
  contienen el valor ni su longitud; el screenshot enmascara el campo; origen distinto → rechazo.
- `bun test` + `bun typecheck` en `packages/harness-server`.

## WA-6 — Vista en vivo y takeover · P1

**Falta:** que el usuario vea y pueda intervenir.

**Acceptance**

- `GET .../frame` con polling + evento `browser.frame` (SSE existente) para refrescar la vista.
- Panel `agent-browser` en `WorkspacePanels.tsx`: frame, URL/título/estado y Take over / Release /
  Stop. Take over revela la ventana headed real y pausa al agente; Release reanuda.

**Tests**

- Manual E2E en macOS: el agente navega, el usuario ve frames, pausa, toma el control en la ventana y
  detiene; la tool termina limpiamente.
- `bun typecheck` en `packages/harness`.

## WA-7 — Scheduling con Routines · P0

**Falta:** publicar a una hora, sin colgar en desatendido.

**Acceptance**

- Una acción con navegador y sin reglas allow se avisa en la creación de la routine (fail-closed).
- Una routine puede dirigir una acción; cada ejecución es un Run normal con evidencia y fallo
  registrados.
- Preset de UI para elegir acción, hora e inputs desde un artefacto.

**Tests**

- `scheduler`/`api.test.ts`: routine browser sin allow → warning y no lanza; con allow → completa y
  deja artefactos; el fallo aparece en el Run.
- `bun test` + `bun typecheck` en `packages/harness-server`.

## WA-8 — Config UI de acciones (PoC) · P0

**Falta:** que todo se configure desde la app.

**Acceptance**

- Panel **Acciones**: crear/editar perfil (origin, credential, inputs, steps, extract, guards; scope
  global/project) validando contra el esquema; errores accionables.
- "Capturar selector" desde la vista en vivo y **dry-run** de la acción contra el navegador.
- Integración con `config-files`: los perfiles se exportan al repo de config del usuario
  (`bun run repo-hygiene`).

**Tests**

- `config-files.test.ts` cubre perfiles exportados; validación rechaza un perfil roto.
- e2e editor de acciones en verde.
- `bun test` + `bun typecheck` en `packages/harness` y `packages/harness-server`.

## WA-9 — Packaging y hardening · P0 (bloqueante de release)

**Falta:** que un navegador logueado no sea alcanzable por cualquier página local, y que se pueda
distribuir.

**Acceptance**

- Chromium gestionado empaquetado (o canal Chrome del sistema como fallback), con `executablePath` y
  `extraResources`; los binarios anidados se firman (verificar `after-pack.cjs`); sin entitlement
  nuevo de macOS (Playwright no usa accessibility/captura).
- Auth y **CORS restringido** en `/harness/browser/*`; el token no se filtra.
- `/harness/artifacts*` (y en particular los `screenshot` que produce el runtime WA-1) detrás de
  auth/token y CORS restringido; un `screenshot` es dato sensible para la redacción (WA-5).
- Contenido de página = **no confiable** (anti prompt-injection): un texto de página nunca autoriza
  una acción.

**Tests**

- Tests de auth/CORS/SSRF fail-closed; revisión de `security`.
- App empaquetada en macOS lanza Chromium desde `extraResources` en una cuenta limpia.

## WA-10 — PoC de validación (caso de uso, sin código) · P0

**Falta:** demostrar el caso real (sitio concreto + pieza concreta) y que el motor no está sesgado a
publicar.

**Acceptance**

- Perfil de publicación en el sitio real **fuera del repo** (credencial + receta), con el texto y la
  imagen ya compuestos.
- Routine a la hora elegida: el post sale con texto + imagen; quedan artefactos de evidencia.
- Segunda acción de **lectura** (`extract`) configurada y ejecutada, para probar el sesgo.
- El caso queda documentado en el repo de config del usuario, no en FlupCode.

**Tests**

- Ejecución real programada en verde; verificación manual del post publicado y de la lectura.
- `bun run repo-hygiene` en verde (nada del caso entró en el repo).
