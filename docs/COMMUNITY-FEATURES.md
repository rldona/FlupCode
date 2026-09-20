# Comunidad OpenCode → FlupCode

Estudio de las funcionalidades que pide la comunidad de OpenCode (`anomalyco/opencode`) y
que FlupCode podría incorporar **en su propia capa** (harness web, desktop, remote, plugins de
experiencia, notificaciones, a11y). Fecha del barrido: **2026-09-20**.

Este documento **no** propone reimplementar el motor. FlupCode es upstream-first: hereda todo lo
que vive en `core`/`server`/`protocol`. Aquí solo se listan capacidades que el harness puede
poseer, editar y diferenciar sin tocar upstream (ADR-0001).

Fuentes primarias: issues y PRs de `anomalyco/opencode` ordenados por reacciones y comentarios,
etiqueta `enhancement`, y búsquedas por clúster. Cada fila referencia el issue/PR que la origina.

---

## 1. Método y reglas de filtrado

**Barrido realizado.** Seis pasadas sobre GitHub, solo lectura:

1. Issues abiertas ordenadas por reacciones y por comentarios (las más pedidas).
2. Etiqueta `enhancement` y búsquedas de `[FEATURE]` / "feature request".
3. Clúster UI/UX: app, web, desktop, temas, keybinds, notificaciones, móvil, accesibilidad.
4. Clúster sesión/agente/memoria/contexto/permisos/undo/cola/coste.
5. Clúster automatización/plugins/skills/MCP/git/CI/IDE/remote/nube.
6. Pull requests abiertas y mergeadas; y lista de lo ya enviado por upstream (para excluir).

Cada candidata se cruzó con `docs/PARITY.md`, `docs/ROADMAP.md` y `docs/AUDIT-2026-09.md` §17
(H-01…H-47, HF-1…HF-9) para marcarla como **tiene / en backlog / nueva**.

**Reglas de exclusión ("lo de upstream").** Se descartan dos categorías:

- **Ya enviado o comprometido por upstream.** No se re-backlogea; FlupCode lo hereda o lo gana al
  sincronizar `dev`. Ver §5.A.
- **Motor/core.** Providers, protocolo, base de datos, LSP interno, compilación de prompts,
  rendimiento del motor, snapshots, streaming de proveedor, billing. FlupCode no lo posee. Ver §5.B.

Y una tercera, de producto: **ya descartado explícitamente por FlupCode** (H-39, H-41, H-42,
kanban, marketplaces, mensajería entre agentes…). Se conservan en §5.C para poder revisitarlos si
la señal de comunidad crece.

**Priorización.** Impacto = encaje estratégico con las primitivas del harness (Run/Workflow/
Artifact/Checkpoint/Policy/Context Pack, AUDIT §20) × demanda de comunidad (reacciones y
comentarios), ajustado por esfuerzo y riesgo. Escala de esfuerzo: **S** ≤ 3 días · **M** ≤ 2
semanas · **L** ≤ 4 semanas · **XL** más.

**Límites del dato.** GitHub no muestra el total de reacciones en los listados server-rendered; los
números de esta tabla son **aproximados** y provienen de varias búsquedas. Los estados de PR
(abierta/mergeada) son de 2026-09-20 y pueden cambiar. Los títulos de features se traducen; el
número de issue es la referencia fiable.

---

## 2. Tabla priorizada

### P0 — Crítico: encaje estratégico alto y demanda fuerte

| ID | Idea | Señal (issue #, reacciones aprox.) | Qué es | Estado en FlupCode | Encaje | Esf. | Notas / riesgo |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **CF-01** | Plataforma de plugins + hooks de ciclo de vida + API de UI | #12472 (~41), #50133, #7006 (~26), #30509, #34329, #5207 (mergeado), #9272, #5971 (~54), #6330 (~25), #41037, #12490, #49962 (mergeado) | Hooks `tool.execute.before/after`, `permission.ask`, `session.before.idle`, `Stop`; paneles de sidebar registrables; canal de "UI intent" (formularios/confirmación/toast); gestor de plugins/LSP y activar/desactivar; toasts por sesión | ❌ Sin superficie de plugins (`PARITY` §6) | **Muy alto.** Es la palanca de extensibilidad del harness; ya hay precedente de plugin de motor (variantes). Convierte cada petición de la comunidad en algo que un tercero puede construir | L | Riesgo de seguridad: hooks deben respetar políticas que solo restringen (H-04). Empezar por hooks de solo lectura |
| **CF-02** | `/goal`: objetivos de sesión persistentes | #27167 (~201, ~79c) | Un objetivo por sesión con estado (activar/pausar/reanudar/completar), continuación cuando la sesión queda ociosa, presupuestos de tokens/tiempo y tools visibles para el modelo | 🆕 Nueva (lo más cercano: Runs H-11 y Rutinas HF-8, pero son de harness) | **Alto.** Versión ligera del Run dentro de una sesión; puente natural entre sesión y run, con gates reutilizables | M | No confundir con Run: el objetivo es de sesión, no una entidad durable. Reusar presupuesto (H-30) |
| **CF-03** | `/btw`: pregunta lateral sin ensuciar el hilo | #16992 (~206–396, el más pedido), PR #49750 y #17198 abiertas | Overlay/pregunta tangencial con todo el contexto pero sin tools ni historial que contamine la sesión principal | 🆕 Nueva | **Alto.** Encaja en el composer y en la filosofía de sesiones hijas; el harness ya usa hijos ocultos en otros flujos | S–M | Evitar el coste por turno de las sesiones ocultas (lección de reply-suggestions) |
| **CF-04** | Expandir texto pegado (`[Pasted ~N lines]`) | #8501 (~240–323) | Ver/editar en el sitio el bloque que el composer resume al pegar | 🟡 Parcial (F3-11 resume, no expande) | **Alto.** Barato y muy pedido; vive entero en `Composer` | S | Cuidar no romper el resumen que evita prompts gigantes |
| **CF-05** | Integración IDE / extensión VS Code | #11176 (~162, ~29c), #18649, #15631, #37891, #26772 (~10), #10119 | Extensión/panel de VS Code, contexto de selección del editor en vivo, abrir ficheros y URLs desde el transcript, navegador integrado | ❌ (`PARITY` §3 "IDE selection context") | **Alto.** El mayor hueco de ecosistema; reutiliza el motor client/server ya existente | L–XL | Producto aparte; decidir si FlupCode quiere ser cliente de IDE o concentrarse en web/desktop. Empezar por "abrir en editor" (#37891) |
| **CF-06** | Sistema de temas y tipografía | #49340, #44590, #41957, #37423, #27684, #5657, #48977 | Catálogo de temas (más allá de 2 paletas), tema por sistema, fondo transparente, tamaño de fuente/altura de línea, hot-reload de temas | ❌ `PARITY` §9: solo 2 paletas + claro/oscuro | **Alto.** El sistema de diseño es un pilar de FlupCode (DESIGN.md); los tokens `--fc-*` ya existen, falta catálogo y selector | M | Mantener la prueba que ata el CSS a los tokens |
| **CF-07** | Accesibilidad, RTL e i18n | #33137, #41408, #43771, #46396, #49535, #49102, #26915, #35319, #16875, #32726, #33201, #34697, #35896, #39093, #34593, #42782, #43643, #49889 | Lectores de pantalla con contenido en streaming, navegación por teclado, RTL (árabe/hebreo/persa) correcto, localizaciones completas, timestamps por locale, idioma de razonamiento del modelo | 🟡 F7-1 lo declara hecho, pero la evidencia upstream muestra huecos | **Alto.** Upstream cerró RTL como **not planned** (`#49364`): es white space. Este repo ya tiene skill `rtl-aware-development` | M–L | RTL toca layout, scroll, resize, iconos, titlebar; usar la skill existente |
| **CF-08** | Memoria automática entre sesiones | #20322 (~7), #48497, #30116, #41453, #43068, #16077, #32658 | Extracción en segundo plano de conocimiento, candidatos revisables, recall automático por relevancia (no solo inyección manual) | 🟡 H-37 memoria de proyecto manual; sin extracción ni recall | **Alto.** `CONTEXT.md` ya define el dominio Memory (scopes, candidatos, anclas, retrieval, uso por turno). Es una primitiva planificada | L | No es un Context Source (depende del prompt pendiente); seguir el glosario. Candidatos requieren aprobación |
| **CF-09** | Hot-reload de agentes, skills, comandos y config | #8751 (~99–111), #6719 (~83), #37423 | Aplicar cambios en ficheros de config sin reiniciar el motor; `/reload` | 🟡 H-13/H-27 editan ficheros; el motor necesita recarga | **Alto.** La edición ya existe; el ciclo editar→usar está roto sin recarga | M | Depende de lo que exponga el motor (algunos cierres V2 ya lo traen) |
| **CF-10** | Sandbox de ejecución del agente | #2242 (~84, ~91c), #48411, #43227 | Aislamiento de sistema operativo/contenedor; modo bare determinista; permisos de ejecución más ricos | 🟡 H-47 confinamiento (`external_directory`, techo por tool), sin sandbox | **Alto.** Una de las peticiones de seguridad más comentadas; upstream cerró `docker sandbox` como **not planned** (`#9132`) → white space | L–XL | Decidir alcance real (contenedor vs confinamiento mejorado) y decirlo con honestidad |

### P1 — Importante: demanda clara, encaje medio-alto

| ID | Idea | Señal (issue #) | Qué es | Estado en FlupCode | Encaje | Esf. | Notas / riesgo |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **CF-11** | Tokens/segundo y métricas de sesión | #5374 (~110), #49380, #12721, #6096, #49379, #49674 (mergeado) | Lectura de tok/s en vivo, pestaña de rendimiento por sesión, barra de métricas de proveedor | 🟡 H-16 tiene coste/tokens, no throughput | Medio-alto. Observabilidad ya existe, es añadir el dato | S | — |
| **CF-12** | Cola con programación y agente/modelo por prompt | #5408 (~34–42), #48356, #44926 | Retrasar/programar un prompt encolado; ligar agente/modelo/variante a cada encolado; editar la cola con claridad | 🟡 H-07 encola/reordena/cancela; sin delay ni binding | Alto. Extiende una primitiva ya construida | M | Alinear con la semántica queue/steer del motor (CONTEXT.md) |
| **CF-13** | Invocación de skills más rica | #34498 (~65), #15617 (~27), #25570 (~26), #35341, PR #29217 | `$skill` inline con pill, varias skills por prompt, respetar `disable-model-invocation`, auto-registrar `/` desde skills | 🟡 H-27 lista el catálogo; invocación solo `/name` | Alto. El catálogo ya está; falta la ergonomía de invocación | S–M | — |
| **CF-14** | Permisos: auto-mode y control fino | #37564 (~34), #39015, #40909, #42124, #40332, #40805 | Clasificador LLM que auto-aprueba lo seguro, auto-approve limitado por modelo, `/permissions`, timestamps y explicación del agente en el diálogo, evaluación por conjuntos | 🟡 H-08/H-25 previews, reglas por patrón y grants revocables; falta clasificador y comandos | Alto. Vive en el PermissionDock, que ya es rico | M | El clasificador debe **solo** relajar con criterio explícito y auditable (H-04) |
| **CF-15** | Buscar dentro del transcript (Cmd+F) | #4714 (~66), #19143 (~14), #41354 | Find-in-session con navegación entre coincidencias | 🟡 H-18 tiene búsqueda server-side entre sesiones, no dentro del hilo | Medio-alto. Diferencia de calidad percibida en transcripts largos | S–M | Coordinar con el virtualizado del timeline |
| **CF-16** | MCP Apps y actividad MCP | #10884 (~58), #43717 (~12), #48855, #25961 | Renderizar "apps" MCP-UI, actividad/progreso de tools MCP en sidebar, notificaciones MCP personalizadas, CIMD en OAuth | 🟡 H-34 estado/recursos; sin apps, logs por servidor ni sidebar | Medio-alto. MCP ya es de primera clase en FlupCode | M | MCP Apps puede requerir contrato del motor |
| **CF-17** | Notificaciones de fin/progreso e historial | #48026, #50082, #37120, #49961, #39936 | Notificación nativa al terminar o al requerir atención, historial persistente de toasts, arreglo en Android PWA y VS Code | 🟡 F6-3/F8-9 push al móvil; sin notificación de escritorio ni historial | Medio-alto. Remote ya notifica; falta el escritorio | S–M | — |
| **CF-18** | Remote por SSH y Tailscale | #7790 (~115, ~19c), #49291 | Perfiles de conexión SSH (port-forward) al motor remoto y pairing por LAN/Tailscale | 🟡 F8 relay propio; sin transporte SSH | Alto. Amplía el control remoto ya existente a casos corporativos | M | Complementa, no sustituye, el relay E2E |
| **CF-19** | Política de contexto/compactación configurable | #49463, #42574, #48596, #40113, #43703 | Retención determinista de mensajes de usuario, prompt de compactación propio, resumen colapsable por defecto, umbral por modelo | 🟡 La compactación corre; sin superficie de política ni marcador en el timeline (`PARITY` §2) | Medio-alto. Encaja con Context Inspector (H-17) | M | Parte puede necesitar contrato del motor |
| **CF-20** | Capacidades de subagentes | #6651 (~85), #27110 (~33), #38966, #41667, #38963 | Modelo por Task dinámico (`model_tier`), tope de subagentes en paralelo, steer/cancel individual, mensajería padre-hijo | 🟡 H-30 modelo por rol (runs), H-12 steer; falta por Task y tope | Medio-alto. El supervisor ya existe | M | La mensajería padre-hijo choca con H-42 (descartado); valorar |
| **CF-21** | Undo/redo correcto y límites | #43034, #41266, #44202, #28843, #46872 | Redo que no borre historial, undo que arrastre el boundary de compactación, undo que cancele la cola, undo de todos | 🟡 `PARITY` §2: sin redo ni marcador en timeline | Medio. F3-4 y H-15 existen; es corrección + marcadores | M | — |
| **CF-22** | Operación de instancia y routing | #7624 (~49), #14212, #39633, #47906 | Base path/prefijo tras reverse-proxy, backends de estado, página de login apta para gestores de contraseñas, título configurable | ❌ | Medio. Relevante para el harness-server y despliegues | M | Más ops que producto, pero desbloquea adopción seria |

### P2 — Medio: valioso, no urgente

| ID | Idea | Señal (issue #) | Qué es | Estado en FlupCode | Encaje | Esf. | Notas |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **CF-23** | Layout configurable | #36942 (~45), #38308, #34419, #16349, #40086, #35513 | Tabs verticales, intercambiar paneles izquierda/derecha, sidebar persistente configurable, ancho | 🟡 Paneles partidos (`split.ts`), tabs (H-36) | Medio | S–M | FlupCode ya tiene su propio shell; es opción, no rediseño |
| **CF-24** | Adjuntos grandes con progreso | #49647 (mergeado) | Subida en streaming con progreso | 🟡 | Medio | S | — |
| **CF-25** | Tabs de artefacto enriquecidas | #49882 | Los ficheros citados por el agente se abren como tabs de artefacto ricas | 🟡 H-14 artifacts; sin auto-tabs | Medio | M | Encaja con "añadir al contexto" pendiente de H-14 |
| **CF-26** | Pestaña de rendimiento / debug de proveedor | #49379, #49674 | Métricas por sesión y latencia/tokens por proveedor | 🟡 H-16 | Medio | S–M | Fusionar con CF-11 |
| **CF-27** | Reset de contexto sin nueva sesión | #31657 | Vaciar/limpiar el contexto in situ | 🆕 | Medio | S | "Clean context" al salir de plan mode (#13971) es el mismo patrón |
| **CF-28** | Árbol de sesión y navegación de ramas | #41363 | Historial ramificado, rollback-y-continuar desde cualquier mensaje | 🟡 fork desde mensaje (F3-4) | Medio | M | — |
| **CF-29** | Ciclo de vida y reclamación de almacenamiento | #16101 | Reclamación de espacio, auto-archivado, limpieza de sesiones hijas | 🟡 H-18 archiva; sin reclamación | Medio | S–M | El audit ya alertaba de caché sin LRU |
| **CF-30** | Picker global de sesiones / resume | #31932, #35581, #36134, #42058, #467 | Picker cross-proyecto, indicar alcance, `-r/--resume` | 🟡 H-18 búsqueda/paginación | Medio | S–M | — |
| **CF-31** | Portapapeles y selección | #10490 (~34), #49601, #47717, #4283 (~127) | Desactivar copy-on-select, copiar respuesta completa, poder seleccionar texto donde hoy no se puede | 🟡 | Medio | S | #4283 es además un bug de regresión en el renderer |
| **CF-32** | Modo vim y atajos alternativos | #1764 (~197 cerrado), #11111 (~50), #35608, #40048 | Movimientos vim en el input, layout vim, intercambiar Return/Shift+Return, Ctrl+. en teclados no US | ❌ | Medio. H-24 permite capturar atajos, no modo vim | M | — |
| **CF-33** | Export OpenTelemetry | #5245 | Exportar trazas/métricas por OTLP | 🟡 H-16 "Future: OTel export" | Medio. Ya está en el roadmap de H-16 | M | — |
| **CF-34** | UX de proveedores y modelos | #14524 (~12), #32485, #48282, #5391 (~42), #6231 (~247) | Coste en el picker, moneda configurable, nombres de modelo propios por UI, varios perfiles de auth por proveedor | 🟡 ProvidersPanel; #6231 es motor | Medio | M | #6231 (auto-descubrir modelos) es motor: no reimplementar, esperar herencia |
| **CF-35** | Equipos de agentes con mensajería | #12711 (~73) | Equipos planos, mensajería con nombre, multi-modelo | ❌ H-42 descartado | Medio (revisar) | L–XL | Mantener descartado salvo que el DAG (H-28) no baste; ya está razonado en el audit |
| **CF-36** | Apps móviles nativas y notificaciones Android | #10288 (~100), #49961, #49357 | App nativa o PWA pulida con notificaciones fiables y mejor indicador de "trabajando" | 🟡 F6-1 PWA + F8 remote | Medio | M | FlupCode ya está por delante de upstream aquí; es pulido |
| **CF-37** | Prompts de sistema personalizables | #7101 (~168 cerrado) | System prompt a nivel global/proyecto | 🟡 H-17 inspector captura el prompt | Medio | M | Upstream lo cerró pidiendo hooks; en FlupCode encaja como Context Pack (H-31) |

### P3 — Futuro / a revisar

| ID | Idea | Señal (issue #) | Qué es | Estado | Notas |
| --- | --- | --- | --- | --- | --- |
| **CF-38** | Localización de texto del motor por plugin | #45490 | Hook para que un plugin traduzca el texto nativo | 🆕 | Depende de CF-01 |
| **CF-39** | Marketplace de plugins/skills/MCP | #28696 (~38), #7467 (~46), #40993 | Catálogo/índice, estándar Agent Plugins | ❌ H-41 cerrado sin construir | Ya razonado: sin comunidad no hay catálogo. Instalar por URL/carpeta ya existe (H-27) |
| **CF-40** | Servidor/instancia: flota y join | #44760 | `opencode join`, hub con descubrimiento central de sesiones | ❌ | Solo si FlupCode va a multi-host (future de H-10) |
| **CF-41** | Git: contexto de trabajo ligado a issue/PR | #42396 (~45), #49754 | Contexto durable atado a issue/PR de GitHub + worktree; resúmenes de commit seguros | 🟡 H-29 worktrees, H-20 git/PR | Extiende el panel git existente |
| **CF-42** | Keybinds: documentación y cobertura | #44673, #35740 | Documentar los keybinds definidos; pistas de atajo consistentes | 🟡 H-24/H-F3-17 | Pulido de documentación |
| **CF-43** | Barra de acciones/estado en tabs | #42416, #38985, #25262 | Indicador de estado por sesión en la pestaña y topbar | 🟡 tabs H-36, Topbar | Pulido |
| **CF-44** | Ctrl+C no debe salir / doble Ctrl+C | #7957 (~59), #2999 (~28), #50088 | Protección de salida accidental | ❌ (más TUI que harness) | Aplica al host de terminal de FlupCode y a `flupcode remote` |

---

## 3. Deep-dives por clúster

### 3.1 Plugins y hooks — la palanca que falta (CF-01)

Es el clúster con más señal agregada y el único que no es una feature aislada: es un **cambio de
categoría**. La comunidad pide paridad con los hooks de Claude Code (`PreToolUse`, `PostToolUse`,
`Stop`), un canal de UI para plugins, paneles de sidebar registrables, gestión de plugins/LSP y
toasts por sesión. FlupCode ya tiene el precedente de un plugin de motor (variantes) y la
arquitectura de AUDIT §18 prevé `@flupcode/engine-plugin` para capturar system prompt, timing de
tools y política de permisos. Construir esta superficie convierte el resto de este documento en
trabajo de terceros.

Secuencia sugerida: hooks de observación (solo lectura) → hooks de política (`permission.ask`,
`tool.execute.before`) → API de UI intent y paneles → gestor visual y activar/desactivar.

### 3.2 Sesión: `/goal`, `/btw`, cola y contexto

Cuatro peticiones muy pedidas tocan la misma zona:

- `/btw` (CF-03) y `/goal` (CF-02) son **semántica de sesión**, no entidades nuevas. El Run ya
  resuelve objetivos durables; CF-02 es su versión ligera dentro de una sesión y debe reusar
  presupuesto y gates.
- La cola (CF-12) extiende H-07 con programación y binding de agente/modelo. Respetar la
  distinción queue/steer de `CONTEXT.md`.
- La compactación configurable (CF-19) es la cara visible del Context Epoch; el Context Inspector
  (H-17) ya captura el dato, falta la política y el marcador en el timeline.

### 3.3 IDE / VS Code (CF-05)

El mayor hueco de ecosistema y una decisión de producto: FlupCode es hoy web+desktop+remote. Antes
de una extensión nativa, el tramo barato es "abrir en editor" y "hacer clicables rutas y URLs"
(#37891, #15631), que ya aparecen como gaps en `PARITY` §7 y §9. Una extensión completa es XL y
compite por atención con la diferenciación de Runs.

### 3.4 Temas, accesibilidad, RTL e i18n (CF-06, CF-07)

Upstream tiene ~40 temas; FlupCode tiene dos paletas. El sistema de tokens `--fc-*` está listo para
un catálogo. En a11y, lo importante: **RTL es white space** porque upstream lo cerró como *not
planned*, y este repo ya tiene la skill `rtl-aware-development`. La accesibilidad de lectores de
pantalla con contenido en streaming es un hueco real que F7-1 dio por hecho.

### 3.5 Memoria (CF-08)

`CONTEXT.md` ya define el dominio Memory completo (scopes global/project/agent/session, candidatos,
anclas, retrieval determinista, uso por turno). H-37 implementó la parte **manual**. Lo que pide la
comunidad es la parte **automática**: extracción en segundo plano, candidatos revisables y recall
por relevancia. Es la evolución natural de una primitiva ya especificada.

### 3.6 Sandbox (CF-10)

Una de las peticiones de seguridad más comentadas y sin dueño: upstream cerró `docker sandbox`
como *not planned*. H-47 confina y techa, pero el audit dice explícitamente "no hay sandbox". Antes
de construirlo hay que decidir el alcance (contenedor real vs confinamiento reforzado) y
comunicarlo sin sobreprometer.

---

## 4. Matriz impacto / esfuerzo

| Feature | Impacto | Esfuerzo | Encaje harness | Prioridad |
| --- | ---: | ---: | ---: | --- |
| CF-01 plugins/hooks | 5 | L | 5 | P0 |
| CF-02 `/goal` | 5 | M | 5 | P0 |
| CF-03 `/btw` | 4 | S–M | 5 | P0 |
| CF-07 a11y/RTL/i18n | 4 | M–L | 4 | P0 |
| CF-08 memoria automática | 4 | L | 5 | P0 |
| CF-05 IDE/VS Code | 4 | L–XL | 3 | P0 |
| CF-06 temas/tipografía | 4 | M | 4 | P0 |
| CF-10 sandbox | 4 | L–XL | 4 | P0 |
| CF-04 paste expandible | 3 | S | 4 | P0 |
| CF-09 hot-reload | 3 | M | 4 | P0 |
| CF-14 permisos auto-mode | 4 | M | 4 | P1 |
| CF-18 remote SSH/Tailscale | 4 | M | 4 | P1 |
| CF-20 subagentes | 3 | M | 4 | P1 |
| CF-13 skills invocación | 3 | S–M | 4 | P1 |
| CF-19 compactación config | 3 | M | 4 | P1 |
| CF-16 MCP Apps | 3 | M | 4 | P1 |
| CF-12 cola avanzada | 3 | M | 4 | P1 |
| CF-11 tok/s y métricas | 3 | S | 3 | P1 |
| CF-15 buscar en transcript | 3 | S–M | 3 | P1 |
| CF-17 notificaciones | 3 | S–M | 3 | P1 |
| CF-21 undo/redo | 3 | M | 3 | P1 |
| CF-22 ops/routing | 3 | M | 3 | P1 |

---

## 5. Descartadas (no re-backlogear)

### 5.A Ya enviado o comprometido por upstream

FlupCode lo hereda vía `dev`; no se reimplementa. Entre las de mayor demanda histórica:

- Skills (`SKILL.md`) #3235 · Plan mode con preguntas #3844 · Permisos en TUI y `--dangerously-skip-permissions` #239/#8463/#1813 · Comandos slash personalizados #299 · Integraciones de editor base #216 · ACP/Zed #892.
- MCP: OAuth remoto #988, recursos y prompts #806, búsqueda de tools y carga perezosa #8277/#8625, salida de tools #6604.
- Descubrimiento de `AGENTS.md` #6316 · Smart rules compatibles con Claude Code #10096 · Reglas por conjuntos en permisos (tendencia #40805).
- Render: tablas markdown #3845, LaTeX #11655, Mermaid #3366, resumen de coste por sesión #4925, stats de sesión #5555, toggle de thinking #10470, REPL #4355.
- Tema claro/oscuro automático #9697 · logo configurable #12016 · desactivar ratón #6824 · auto-sync de proyectos web #13626 · móvil-friendly #5126 · desarchivar #12393 · editar ficheros en la web #11501 · picker de worktree/rama #13343 · diff review aceptar/rechazar #9578.
- Wiring de proveedores y modelos (OpenAI OAuth #1686, GPT-5.x, Copilot, Kimi, DeepSeek, Opus, `/fast`, balance de Go #16017, etc.).

### 5.B Motor / core (FlupCode no lo posee)

Providers y auth, descubrimiento automático de modelos (#6231), fallback de modelo (#7602),
protocolo HttpApi/SDK, base de datos y migraciones, LSP/formatter internos, compilación de
contexto y compaction loop (#15533), snapshots y locks de git, streaming de proveedor y deadlocks
SSE, fugas de memoria y rendimiento del motor, billing/Zen, plataformas (Bun segfault, Windows
arm64), A2A/ACP como protocolo. Todo esto se corrige o se espera upstream.

### 5.C Ya descartado por FlupCode (revisar solo si la señal crece)

Marketplace de skills/MCP/workflows (H-41) · mensajería entre agentes / mailboxes (H-42) · smart
context con índice semántico (H-39) · kanban de tareas · grafo de dependencias en ejecución · Chat
como runtime separado · comparaciones de uso con libros · sugerencias de respuesta por turno (coste
real) · Mermaid · edición in-place de mensajes más allá de editar y reenviar.

> **Nota de revisión:** CF-35 (equipos de agentes, #12711, ~73 reacciones) merece una segunda
> mirada. El audit descartó los mailboxes "salvo que el DAG no baste". Si los Runs con DAG (H-28)
> demuestran que la coordinación por dependencias no cubre casos reales, esta es la petición que lo
> justificaría.

---

## 6. Fuentes

**Issues y PRs de `anomalyco/opencode` (2026-09-20), por sección:**

- **P0:** CF-01 #12472 #50133 #7006 #30509 #34329 #5207 #9272 #5971 #6330 #41037 #12490 #49962 · CF-02 #27167 · CF-03 #16992 #49750 #17198 · CF-04 #8501 · CF-05 #11176 #18649 #15631 #37891 #26772 #10119 · CF-06 #49340 #44590 #41957 #37423 #27684 #5657 #48977 · CF-07 #33137 #41408 #43771 #46396 #49535 #49102 #26915 #35319 #16875 #32726 #33201 #34697 #35896 #39093 #34593 #42782 #43643 #49889 · CF-08 #20322 #48497 #30116 #41453 #43068 #16077 #32658 · CF-09 #8751 #6719 #37423 · CF-10 #2242 #48411 #43227.
- **P1:** CF-11 #5374 #49380 #12721 #6096 #49379 #49674 · CF-12 #5408 #48356 #44926 · CF-13 #34498 #15617 #25570 #35341 #29217 · CF-14 #37564 #39015 #40909 #42124 #40332 #40805 · CF-15 #4714 #19143 #41354 · CF-16 #10884 #43717 #48855 #25961 · CF-17 #48026 #50082 #37120 #49961 #39936 · CF-18 #7790 #49291 · CF-19 #49463 #42574 #48596 #40113 #43703 · CF-20 #6651 #27110 #38966 #41667 #38963 · CF-21 #43034 #41266 #44202 #28843 #46872 · CF-22 #7624 #14212 #39633 #47906.
- **P2:** CF-23 #36942 #38308 #34419 #16349 #40086 #35513 · CF-24 #49647 · CF-25 #49882 · CF-26 #49379 #49674 · CF-27 #31657 #13971 · CF-28 #41363 · CF-29 #16101 · CF-30 #31932 #35581 #36134 #42058 #467 · CF-31 #10490 #49601 #47717 #4283 · CF-32 #1764 #11111 #35608 #40048 · CF-33 #5245 · CF-34 #14524 #32485 #48282 #5391 #6231 · CF-35 #12711 · CF-36 #10288 #49961 #49357 · CF-37 #7101.
- **P3:** CF-38 #45490 · CF-39 #28696 #7467 #40993 · CF-40 #44760 · CF-41 #42396 #49754 · CF-42 #44673 #35740 · CF-43 #42416 #38985 #25262 · CF-44 #7957 #2999 #50088.

**Documentos internos usados para el cruce:** `docs/PARITY.md`, `docs/ROADMAP.md`,
`docs/AUDIT-2026-09.md` (§17–§20), `CONTEXT.md`, `docs/DESIGN.md`, `docs/adr/`.

**Cómo mantenerlo.** Re-ejecutar el barrido cada trimestre o antes de cada fase del roadmap. Cuando
una fila pase a ticket, enlazar desde aquí al `H-xx`/`CF-xx` correspondiente y moverla a
`docs/ROADMAP.md`.
