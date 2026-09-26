# Web actions — manual E2E (WA-6 · WA-7 · WA-8)

> Estado: WA-0 a WA-9 implementados y commiteados en la rama `web-actions`.
> Este documento es el guion de verificación manual. El caso real con sitio concreto
> (WA-10) vive fuera del repo, en el repositorio de configuración del usuario.

## 0. Puesta en marcha

1. Cierra la app empaquetada si está abierta (ocupa el 4097 con un harness viejo).
2. Desde `packages/harness-desktop`: `bun run dev`. Se levantan engine (4096) y
   harness (4097) emparejados por token.
3. Comprueba `GET http://localhost:4097/harness/health`: debe listar
   `browser`, `web-actions`, `credentials` y `action-profiles`.
4. Usa la **ventana desktop**, no una pestaña web: solo ella recibe el token
   (`window.flupcode.browserToken`). En pestaña, las rutas con bearer dan 403
   por diseño.

## E2E-1 — Editor: crear, validar, previsualizar, guardar

1. Abre **Actions → New action** y rellena un perfil de lectura contra un sitio
   estático y público (p. ej. `https://example.com`):
   id/tool/descripción, origin, sin credential, `sensitive: false`,
   steps `goto {{origin}}/`, `waitFor h1`, extract `title` de `h1` como texto.
2. **Validate** → mensaje inline "The profile is valid." (sin modal).
3. **Preview** → los pasos de lectura salen `ok`, los de efecto `skipped`;
   no se resuelve credencial ni se archiva evidencia; el navegador del preview
   se cierra solo al terminar (si no, el siguiente run choca con `browser_busy`).
4. **Save** → mensaje con la ruta. El perfil queda en la config global.
5. **Reinicia el engine** (o la app): el plugin registra tools solo al arrancar.

OK si: validación en verde, preview con corte, guardado con ruta, y tras el
reinicio el agente ofrece la tool nueva.

## E2E-2 — Uso interactivo con aprobación y vista en vivo

1. En un chat con carpeta de proyecto (modo **Agent**, no Plan), pide usar la acción.
2. Aparece **una** aprobación pre-flight (`origin:action`, pasos con efecto,
   screenshot). Aprueba.
3. El panel **Agent browser se abre solo**; el run corre **headless** (ninguna
   ventana del SO). El frame se actualiza sin parpadeos ni spinner a pantalla
   completa; si la sesión cae y reintenta, el panel conserva lo último pintado.
4. Prueba **Take over** (abre la ventana headed en el punto del agente),
   **Release** (reanuda) y **Stop** (termina como `stopped`, no como fallo).
5. Revisa **Artifacts**: screenshots por paso y log de texto ligados al run.

OK si: una sola aprobación, sin ventanas externas salvo takeover, controles
responden, evidencia recuperable, credencial redactada en todo lo visible.

## E2E-3 — Routine programada (WA-7)

1. Crea una routine en modo acción con la receta, sus inputs y su `allow`
   (`origin` para lectura, `origin:action` para efectos). Sin allow se rechaza
   al crear (422 accionable), no se cuelga.
2. Lanza a mano (`runNow`) o espera la hora. Cada ejecución es un Run normal.
3. Abre el Run: estado, pasos, `evidence[]`, artefactos por `runID`/`taskID`.

OK si: el run completa, la evidencia cuelga del run y un fallo aparece en el Run.

## E2E-4 — Caso real con sitio concreto (WA-10, pendiente)

1. Alta de `<site>_account` en el vault **por API** (el valor no pasa por el chat):
   `POST /harness/credentials` con bearer del fichero `browser-token`.
   `GET` lista nombre+origen **sin** el valor.
2. `POST /harness/browser/login` (proyecto = carpeta del caso) y login manual
   en la ventana headed. Si X pide verificación extra (email/teléfono),
   **parar aquí** y cambiar de sitio.
3. Perfil de publicación global (credential por nombre, `sensitive: true`,
   steps con `fill`/`upload`/`submit`+`assert`, selectores capturados) +
   perfil de lectura con `extract`. Validate + Preview de ambos.
4. Prueba interactiva, luego routine con allow a la hora elegida.
5. Verificar el post real (texto + imagen) y documentar el caso **solo** en el
   repo de config del usuario (`.opencode/opencode.jsonc` + `install.sh`):
   nunca la contraseña, ni `vault-key`, ni cookies, ni rutas del perfil.
6. `bun run repo-hygiene` en verde + `git grep` del origen/ids/texto vacío.

## E2E-5 — Caso real con sitio concreto (runbook WA-10)

Sin código: solo configuración fuera del repo. `P` = carpeta del proyecto
(perfil de navegador, routine). `TOKEN` = contenido de `browser-token`.

0. **Sitio**: login usuario+contraseña, sin CAPTCHA/2FA/SSO, publica texto+imagen
   en flujo estable, con confirmación detectable (`assert`). Si hay muro: parar.
1. **Credencial** (la ejecuta una persona; el valor no pasa por el chat):
   `POST /harness/credentials` `{name, origin, secret}` con bearer; `GET` lista
   nombre+origen sin el valor.
2. **Login manual**: `POST /harness/browser/login` (proyecto `P`, sesión a mano)
   en la ventana headed. `clear` para empezar limpio.
3. **Perfil de publicación** global (`credential` por nombre, `sensitive: true`,
   `fill`/`upload`/`submit`+`assert`, selectores capturados) + **perfil de
   lectura** con `extract`. Validate + Preview de ambos.
4. **Prueba interactiva** (modo Agent): una aprobación pre-flight, live view,
   evidencia con credencial redactada.
5. **Routine** en modo acción con `allow` exacto (`origin` lectura,
   `origin:id` efectos), inputs desde artefacto, a la hora elegida.
6. **Verificación**: run en verde, post real con texto+imagen, artefactos por
   `runID`, `extract` de la lectura.
7. **Documentación solo en el repo de config del usuario** (`.opencode` +
   `install.sh`): ids, nombre de credencial, allow, runIDs. Nunca la contraseña,
   ni `vault-key`, ni cookies, ni perfiles de navegador.
8. **Puertas**: `bun run repo-hygiene` verde + `git grep` del origen/ids/texto
   vacío en FlupCode.

## Problemas conocidos y salidas

| Síntoma | Causa | Salida |
|---|---|---|
| 404 en `/harness/actions*` | harness viejo sin runtime | usar el de la rama (capabilities) |
| 403 `invalid_token` en pestaña web | sin token fuera de desktop | usar la ventana desktop |
| PUT bloqueado por CORS | faltaba en `allow-methods` | corregido; reiniciar harness |
| `browser_busy` en un run | sesión de otro chat/editor en el proyecto | Stop/close o reiniciar harness |
| En Plan no hace nada | modo solo lectura | pasar a Agent/Auto |
| Stream `ERR_INCOMPLETE_CHUNKED_ENCODING` | heartbeat empatado con Bun (10s) | heartbeat a 5s; reiniciar harness |
| Ventana externa al actuar | runs antiguos eran headed | headless por defecto desde el fix; takeover la revela |

## Puertas de cierre

- `bun test src` + `bun typecheck` en `harness-server`, `harness`, `remote`
  (y `harness-desktop` typecheck) en verde.
- `bun run repo-hygiene` en verde y sin rutas/secretos del caso en el repo.
