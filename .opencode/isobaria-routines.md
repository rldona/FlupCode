# Las dos routines de Isobaria

Los prompts van en el campo `prompt` de cada routine del harness, con
`agent: isobaria` y `schedule`: `{ "type": "daily", "time": "08:00" }` y
`{ "type": "daily", "time": "12:00" }`. La hora es la local del servidor.

Las reglas de marca, del tiempo y de la plantilla viven en
`.opencode/agent/isobaria.md`. Aquí va solo el encargo de cada franja.

---

## 08:00 · El parte de la mañana (panorama y, si hay avisos, un segundo post)

```text
Escribe y publica el parte de la mañana de Isobaria para X. Son **hasta dos posts**, en este orden, y no preguntas nada: si algo no se puede hacer, dilo y para.

Primero el **panorama, que sale siempre**:

1. `plazoleta_get_national_weather("isobaria", "snapshot")`. Si devuelve un error —`NATIONAL_NOT_SUPPORTED`, `WEATHER_SOURCE_UNAVAILABLE` o cualquier otro—, dilo en una línea y termina: sin snapshot no hay parte.
2. `plazoleta_compose_map("isobaria", "panorama")`. Si no se puede dibujar, di el motivo y para.
3. Escribe una o dos frases sobre el conjunto del país, **sin ninguna cifra**. Si escribes una cifra, quítala. **No nombres un fenómeno que no esté en el snapshot**: lo que el mapa no dibuja, no se dice.
4. `plazoleta_validate_piece("isobaria", "X", texto)`. Si devuelve `ok: false`, reescribe y vuelve a validar; si el mismo código sale tres veces, para y di qué pide esa regla.
5. `plazoleta_create_utm_url("isobaria", "X", "POST")` y pega el valor de `paste` como última línea, con 👉.
6. **Publica el panorama**: `publish-isobaria({ text, template: "panorama", alt })`.

Y **después**, solo si hay avisos, un segundo post con el mapa de avisos:

7. `plazoleta_get_national_weather("isobaria", "alerts")`. Si devuelve un error, **no hay segundo post**: di el motivo y termina. Si `by_province` viene vacío (`{}`), hoy no hay avisos: **no hay segundo post** y terminas. Un error **no es «hoy no hay avisos»**.
8. `plazoleta_compose_map("isobaria", "alerts")`.
9. Escribe una o dos frases: nombra provincias o zonas y su nivel **literal** —`amarillo`, `naranja`, `rojo`, como los escribe AEMET— y **no cuentes nada**: ni cuántas provincias, ni cuántas por nivel, ni porcentajes, ni horas. Nombra siempre alguna provincia. De qué es el aviso, con las palabras de AEMET: `windows[ine].phenomena`. Si citas el aviso, es un titular de `windows[ine].headlines` entre «…» y entero.
10. `plazoleta_validate_piece("isobaria", "X", texto)`, igual que en el 4.
11. `plazoleta_create_utm_url("isobaria", "X", "POST")` y el `paste` como última línea.
12. **Publica los avisos**: `publish-isobaria({ text, template: "alerts", alt })`.

**El orden importa**: compón y publica el panorama **antes** de componer el mapa de avisos. `publish-isobaria` coge la última imagen compuesta en la sesión, así que si compones las dos de golpe, las dos publicaciones saldrían con el mapa de avisos.

Sigue el formato de la plantilla canónica. No digas que son dos pegados ni que hay que copiar nada: publicas tú.
```

---

## 12:00 · La provincia

```text
Escribe y publica el post del mediodía de Isobaria para X. No preguntes nada: si algo no se puede hacer, dilo y para.

1. `plazoleta_get_product_brief("isobaria")` y quédate con `locations`, en el orden en que vienen. Ese orden es la lista; no lo reordenes.
2. `plazoleta_get_weather("isobaria", <slug>)` para cada municipio de la lista. Un fallo puntual de la fuente (`WEATHER_SOURCE_UNAVAILABLE` o `WEATHER_SOURCE_DEGRADED`) **no** es «no hay pieza»: aparta ese municipio y sigue con el resto. Al terminar, vuelve a pedir **una vez** los que fallaron: la fuente cachea la degradación un minuto, y a esas alturas suele haber pasado. Solo paras si **ninguno** devolvió tiempo.
3. Elige entre los municipios que **sí** trajeron datos, así y no de otra manera:
   a) Si algún municipio tiene un aviso de AEMET activo en `alerts`, gana ese. Si hay varios, el de nivel más alto (rojo > naranja > amarillo); si empatan, el primero de la lista.
   b) Si no hay ninguno —o si el tiempo vino con `alerts_available: false`, que significa que los avisos no se pudieron consultar—, gana el que toque por el día de la semana: índice = (número del día − 1) mod (número de municipios de la lista completa), con lunes = 1 … domingo = 7 y el índice desde 0 sobre la lista del paso 1. Si ese municipio quedó apartado, avanza por la lista (circular) hasta el primero con datos.
4. La imagen:
   - Con aviso: `plazoleta_compose_map("isobaria", <plantilla del fenómeno>, <slug>)`.
   - Sin aviso: recorre las plantillas de fenómeno que los datos puedan sostener —`rain`, `wind`, `heat`, `sun`, en ese orden— y quédate con la primera que `compose_map` acepte. `sun` («Despejado») se sostiene cuando no hay avisos ni lluvia. Si todas devuelven `MAP_NOT_AVAILABLE`, entonces `plazoleta_compose_card("isobaria", <la frase de la decisión>, "landscape")`.
5. Escribe el post con la plantilla canónica: decisión, el aviso literal entre «…» si lo hay, la línea 📊 de procedencia, y el enlace. La decisión lleva hora o umbral del payload, siempre. Si los datos no dan una cifra que sostenga una decisión, escribe el registro —«los modelos no se ponen de acuerdo; hoy no lo sabemos»— con el índice a la vista. **Si `alerts_available` es `false`, no cites ningún aviso ni afirmes que no los hay**: ni bloque [AVISO], ni niveles (amarillo/naranja/rojo), ni «sin avisos».
6. `plazoleta_validate_piece("isobaria", "X", texto, location=<slug>)`. Con `location` siempre. Si devuelve `ok: false`, reescribe y vuelve a validar; si el mismo código sale tres veces, para y di qué pide esa regla.
7. `plazoleta_create_utm_url("isobaria", "X", "POST", path="/es/tiempo/<slug>")` y pega el valor de `paste` como última línea, con 👉.
8. Publica: `publish-isobaria({ text, template: <la plantilla del mapa o "card">, location: <slug>, alt })`. Si responde `UNSUPPORTED_PHENOMENON`, reescribe y vuelve al paso 6; si vuelve a caer, dilo y para. Si responde `ALERTS_UNAVAILABLE_CLAIM`, reescribe sin avisos y vuelve al paso 6.

Sigue el formato de la plantilla canónica. No digas que son dos pegados: publicas tú.
```

---

## La rotación, resuelta a mano

Con los cinco municipios del seed —`madrid`, `barcelona`, `valencia`, `sevilla`,
`bilbao`, **en ese orden**—:

| Día       | Número | Índice | Municipio   |
| --------- | ------ | ------ | ----------- |
| lunes     | 1      | 0      | `madrid`    |
| martes    | 2      | 1      | `barcelona` |
| miércoles | 3      | 2      | `valencia`  |
| jueves    | 4      | 3      | `sevilla`   |
| viernes   | 5      | 4      | `bilbao`    |
| sábado    | 6      | 0      | `madrid`    |
| domingo   | 7      | 1      | `barcelona` |

**El aviso gana siempre a la rotación.**

---

## Activación y checklist

Las dos routines se crean **desactivadas** (`enabled: false`).

| Franja                     | ID                                     |
| -------------------------- | -------------------------------------- |
| 08:00 · parte de la mañana | `8c365ce0-b760-4c05-b8f9-7f47a0c861ce` |
| 12:00 · la provincia       | `dcd191c4-6718-4d94-9ebd-0416c0155e66` |

### El PATCH

```bash
# activar
curl -X PATCH http://127.0.0.1:4097/harness/routines/8c365ce0-b760-4c05-b8f9-7f47a0c861ce/enabled \
  -H 'Content-Type: application/json' -d '{"enabled":true}'
curl -X PATCH http://127.0.0.1:4097/harness/routines/dcd191c4-6718-4d94-9ebd-0416c0155e66/enabled \
  -H 'Content-Type: application/json' -d '{"enabled":true}'

# desactivar (vuelta atrás)
curl -X PATCH http://127.0.0.1:4097/harness/routines/8c365ce0-b760-4c05-b8f9-7f47a0c861ce/enabled \
  -H 'Content-Type: application/json' -d '{"enabled":false}'
curl -X PATCH http://127.0.0.1:4097/harness/routines/dcd191c4-6718-4d94-9ebd-0416c0155e66/enabled \
  -H 'Content-Type: application/json' -d '{"enabled":false}'
```

`{id}` es el de la tabla; el host es el del harness (`4097` por defecto).

### Antes de activar — todo en verde

1. **Engine reiniciado**: el agente `isobaria` se creó después de arrancar el
   engine, así que hay que reiniciar FlupCode. Comprobación:
   `curl -s http://127.0.0.1:4096/config | jq -r '.agent | keys[]'` tiene que
   listar `isobaria`.
2. **MCP conectado**: `curl -s http://127.0.0.1:4096/mcp` →
   `{"plazoleta":{"status":"connected"}}`. El token OAuth ya está guardado en
   `~/.local/share/opencode/mcp-auth.json`, así que reconecta al arrancar.
3. **La fuente del tiempo es la del producto**: `get_weather` tiene que traer
   `provenance_models[].run` con valor **y** `confidence_is_product_index: true`.
   Con el respaldo (open-meteo) vienen `run: null` y `false`, y
   `validate_piece` rechaza la pieza.
4. **Secretos en el entorno del engine**: en la raíz de este repo, un `.env`
   (ignorado por git) con `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_UPLOAD_PRESET`
   (el preset, marcado como _unsigned_) e `IFTTT_WEBHOOK_KEY` (y `IFTTT_EVENT`
   si no usas `isobaria_post`). Bun carga ese `.env` al arrancar el engine; si
   el binario no lo leyera, la tool dirá «Falta …» y se pasa al `~/.zshrc`.
5. **Applet de IFTTT**: Webhook → _Post a tweet with image_, con el event name
   que lee `IFTTT_EVENT` (por defecto `isobaria_post`), y la cuenta de X
   conectada.
6. **Imagen alojable**: `compose_map` compone y la tool la sube a Cloudinary; no
   hace falta nada más.

### Primera pasada (manual, no esperar al reloj)

```bash
curl -X POST http://127.0.0.1:4097/harness/routines/8c365ce0-b760-4c05-b8f9-7f47a0c861ce/runs \
  -H 'Content-Type: application/json' -d '{}'
```

Y comprobar, en la sesión del run, que apareció el tuit con su imagen y que
`publish-isobaria` respondió `Publicado en X. Imagen en …`.

### Si algo va mal

- `No se publica. UNSUPPORTED_PHENOMENON`: el guard paró la pieza; el motivo va
  en el resultado.
- `Falta CLOUDINARY_CLOUD_NAME` / `Falta CLOUDINARY_UPLOAD_PRESET` /
  `Falta IFTTT_WEBHOOK_KEY`: faltan en el `.env` de la raíz del repo.
- `MISSING_PROVENANCE` en `validate_piece`: la fuente del tiempo está en el
  respaldo (paso 3).
- Duplicados: la tool no republica la misma pieza el mismo día.

---

## Retirada de las dos tareas de Claude

Cuando las dos franjas hayan publicado una vez desde FlupCode:

1. **Confirma las dos pasadas reales**: `GET /harness/routines/<id>/runs` con
   `success`, y cada una con su tuit y su mapa en X.
2. **Desactiva las dos tareas programadas** del Proyecto «Plazoleta» en Claude
   (08:00 y 12:00). Se crearon con «omitir todas las aprobaciones»: si no se
   apagan, cada franja saldría dos veces.
3. **El conector MCP de Claude puede quedarse**: se retiran las tareas, no el
   conector; sigue valiendo para pedir una pieza a mano.
4. **Anota la decisión en Plazoleta**: PW-539 (la prueba de las tareas) queda
   superada por FlupCode, y `docs/evals/mcp-semana-1.md` ya no decide nada. No
   se mantienen dos caminos por costumbre.
5. **Vigila los primeros días**: cada franja con su run en `success` y su tuit.
   El guard impide republicar la misma pieza el mismo día, pero no comprueba
   que el tuit llegó a salir.
6. **No pares el harness ni el engine**: son el reloj. Sin ellos, no hay
   disparo — no hay cron del sistema.
