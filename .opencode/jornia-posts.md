# Las piezas de Jornia, bajo demanda

A diferencia de Isobaria (`.opencode/isobaria-routines.md`), Jornia **no tiene
routines**: no hay franja horaria ni reloj. Se pide a mano desde el chat
—«dame un post de Jornia»— y el agente escribe el pie y compone la tarjeta en
la misma sesión, para que una persona los copie y pegue.

Lo que en Claude Code era un **Proyecto** aquí son dos ficheros y el conector
que ya está montado:

| Pieza                        | Qué es                                                        |
| ---------------------------- | ------------------------------------------------------------ |
| `.opencode/agent/jornia.md`  | El agente primario y visible: la voz, las guardas y la receta |
| `.opencode/command/jornia.md`| El disparo `/jornia <tema>`; selecciona `jornia` y le pasa el tema |
| `.opencode/tool/deliver-jornia.ts` | Reemite la tarjeta compuesta como adjunto junto al pie   |
| `.opencode/lib/piece-image.ts` | Los helpers de imagen, compartidos con `deliver-isobaria`   |

El **conector MCP** (`plazoleta`, en `.opencode/opencode.jsonc`) es el mismo
que usan las routines de Isobaria: el taller de Plazoleta pone los datos, la
voz, las guardas y la composición. Ninguna tool publica.

## Cómo se usa

- **Con el comando**: `/jornia <tema>` —«post de Jornia sobre las reservas sin
  conexión»—.
- **`/jornia list`** (o `lista`): no genera nada. Llama solo a
  `get_product_brief("jornia")` y devuelve la lista numerada de ganchos y
  pilares, para saber qué temas hay antes de pedir una pieza.
- **Eligiendo el agente** en la barra de la sesión y escribiendo la petición a
  mano.

**Siempre en una sesión donde `jornia` ya sea el agente activo desde el primer
mensaje** —una sesión nueva, o una donde ya lo elegiste antes de escribir—.
Pegar el texto del comando en una conversación que viene de otro agente (por
ejemplo, la de construir este mismo flujo) no lo ejecuta: esa sesión no tiene
las tools `plazoleta_*` y no hay manera de ganarlas a mitad de hilo.

En los dos casos el flujo es el de la receta del agente:

```
get_product_brief("jornia")                 → voz, prohibiciones, umbrales, ganchos
get_network_rules("INSTAGRAM")              → imagen obligatoria, enlaces muertos
get_material("jornia", <tema>)              → **solo si se afirman hechos**
compose_card("jornia", <frase>, "portrait", <captura>)   antes de validar
validate_piece("jornia", "INSTAGRAM", <pie>, topic=<tema>, has_media=true)
deliver-jornia({ text, template, alt })     → la tarjeta como adjunto
```

**En Instagram no hay enlace y sí imagen.** El CTA remite al perfil, y
`create_utm_url` no se usa: esa pieza no se mide. La tarjeta es `portrait`
(1080×1350) y la captura sale de las que `get_material` devuelve y el
`IMAGENES.md` del repo de Jornia declara publicables (`es-ES`).

## Puesta en marcha

1. **Engine reiniciado**: el agente `jornia` y su comando se leen al arrancar.
   `bun run restart:engine` (o `script/restart-engine.sh`) lo reinicia en local.
   Comprobación: `curl -s http://127.0.0.1:4096/config | jq -r '.agent | keys[]'`
   tiene que listar `jornia`.
2. **MCP conectado**: `curl -s http://127.0.0.1:4096/mcp` →
   `{"plazoleta":{"status":"connected"}}`.
3. **Material de Jornia**: `get_material("jornia")` tiene que devolver
   fragmentos y las capturas de `IMAGENES.md`. Sin `MATERIAL_ROOT/jornia`
   clonado, no hay material y la tarjeta se queda sin captura.

## Retirada del Proyecto de Claude

El Proyecto «Plazoleta» de Claude sigue sirviendo para escribir a mano, y el
conector se puede quedar. Lo que se retira es el uso de Jornia **por ahí**
cuando FlupCode entregue la primera pieza real: no se mantienen dos caminos
por costumbre, como ya se hizo con las dos tareas programadas de Isobaria.

## Salvedades

- **La cuenta de Instagram de Jornia todavía no existe** (PW-449, en
  Plazoleta). La pieza se genera igual, pero no hay dónde pegarla hasta que se
  cree. Es una decisión de producto, no un defecto del flujo.
- La tarjeta se compone con el código de Plazoleta (`card_source.py`), no con
  un modelo de imagen: misma frase, mismos bytes, coste cero.
