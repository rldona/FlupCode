---
description: Genera una pieza de Jornia para Instagram, o lista los temas con `list`
agent: jornia
---

Petición: $ARGUMENTS

Si la petición es exactamente `list` o `lista`, sigue la sección **"Listar temas y ganchos, sin generar nada"** de tus instrucciones: solo `get_product_brief("jornia")` y la lista numerada de ganchos y pilares. No generes ninguna pieza ni llames a ninguna otra tool.

En cualquier otro caso, genera y entrega **una pieza de Jornia para Instagram**, con su tarjeta, bajo demanda, sobre ese tema o gancho. Sigue tu receta entera: `get_product_brief("jornia")` → `get_network_rules("INSTAGRAM")` → `get_material("jornia", <tema>)` si vas a afirmar hechos → `compose_card("jornia", <frase>, "portrait", <captura>)` **antes de validar** → `validate_piece("jornia", "INSTAGRAM", <pie>, topic=<tema>, has_media=true)` en verde → `deliver-jornia`.

Si la petición viene vacía, elige el pilar o el gancho más oportuno del brief y di cuál y por qué en una línea antes de escribir. Nada sale sin `validate_piece` en verde.
