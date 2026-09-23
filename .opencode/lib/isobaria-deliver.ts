/**
 * Las piezas puras de `deliver-isobaria`: encontrar el PNG compuesto en la
 * sesión, decidir si la pieza puede salir y leer la disponibilidad de avisos.
 * Sin red y sin ficheros, para poder probarlas.
 *
 * De dónde sale la imagen, que no es obvio: una tool del MCP que devuelve una
 * imagen no deja un `FilePart` suelto en el mensaje. El adjunto queda dentro
 * del estado de la tool que la produjo (`ToolStateCompleted.attachments`,
 * `session.ts:288`), así que hay que mirar ahí y quedarse con el último: el
 * flujo es `compose_map` y después esto. El PNG se lee solo para confirmar que
 * está en la sesión; no se sube ni se publica.
 *
 * Todo lo que llega de fuera se lee con `propertyAt` en vez de con aserciones:
 * son estructuras del host y una aserción no comprueba nada.
 */

type Attachment = { mime?: unknown; url?: unknown }
type Part = { state?: { attachments?: Attachment[] }; attachments?: Attachment[] }
type Message = { parts?: Part[] }

/** El último PNG compuesto en la sesión, como data URL, o `undefined`. */
export function findImageDataUrl(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  const history = messages.filter((message): message is Message => typeof message === "object" && message !== null)
  for (let m = history.length - 1; m >= 0; m--) {
    const parts = history[m]?.parts
    if (!Array.isArray(parts)) continue
    for (let p = parts.length - 1; p >= 0; p--) {
      for (const bag of [parts[p]?.state?.attachments, parts[p]?.attachments]) {
        if (!Array.isArray(bag)) continue
        for (let a = bag.length - 1; a >= 0; a--) {
          const attachment = bag[a]
          if (!attachment) continue
          const { mime, url } = attachment
          if (
            typeof mime === "string" &&
            mime.startsWith("image/") &&
            typeof url === "string" &&
            url.startsWith("data:")
          ) {
            return url
          }
        }
      }
    }
  }
  return undefined
}

/**
 * El data URL del mapa como adjunto de tool, para que la entrega lleve la imagen
 * junto al texto. Solo imágenes: lo que no lo sea no se reemite.
 */
export function imageAttachment(dataUrl: string): { type: "file"; mime: string; url: string } | undefined {
  const mime = /^data:([^;,]+);base64,/.exec(dataUrl)?.[1]
  if (!mime || !mime.startsWith("image/")) return undefined
  return { type: "file", mime, url: dataUrl }
}

/** Un campo de un valor de fuera, sin aserciones ni suposiciones. */
export const propertyAt = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

/** Las palabras con las que una pieza nombra un aviso de AEMET o su ausencia. */
const ALERT_WORDS = /\b(amarillo|naranja|rojo|aviso|avisos|alerta|alertas)\b/

export type AlertsClaimVerdict =
  | { allow: true }
  | { allow: false; code: "ALERTS_UNAVAILABLE_CLAIM"; reason: string }

/**
 * Cuando la capa de avisos de AEMET no se pudo consultar, la pieza no puede
 * citar un aviso ni afirmar que no los hay.
 *
 * `alerts == []` con `alerts_available == false` es «no lo sabemos», no «hoy no
 * hay»: la franja de provincia sale por rotación, sin bloque `[AVISO]` y sin
 * niveles. El agente ya va instruido; esto es la última puerta antes de
 * entregar.
 */
export function assessAlertsClaim(input: {
  text: string
  alertsAvailable: boolean | undefined
}): AlertsClaimVerdict {
  if (input.alertsAvailable !== false) return { allow: true }
  const normalized = input.text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
  if (!ALERT_WORDS.test(normalized)) return { allow: true }
  return {
    allow: false,
    code: "ALERTS_UNAVAILABLE_CLAIM",
    reason:
      "los avisos de AEMET no se pudieron consultar, así que la pieza no puede citarlos ni afirmar que no los hay.",
  }
}

/**
 * Si la fuente pudo consultar los avisos, leído de las salidas de `get_weather`
 * de la sesión. `undefined` cuando ninguna lo dice.
 *
 * Con `location` se busca la salida de ese municipio, que es el de la pieza;
 * sin él, basta con que alguna declare la caída para no dar por bueno lo que no
 * consta. La salida de la tool es el propio JSON de `WeatherContextOutput`.
 */
export function alertsAvailability(messages: unknown, location?: string): boolean | undefined {
  if (!Array.isArray(messages)) return undefined
  const found: { slug?: string; available: boolean }[] = []
  for (const message of messages) {
    const parts = propertyAt(message, "parts")
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      const toolName = propertyAt(part, "tool")
      if (typeof toolName !== "string" || !toolName.includes("get_weather")) continue
      const output = propertyAt(propertyAt(part, "state"), "output")
      if (typeof output !== "string") continue
      let parsed: unknown
      try {
        parsed = JSON.parse(output)
      } catch {
        continue
      }
      const available = propertyAt(parsed, "alerts_available")
      if (typeof available !== "boolean") continue
      const slug = propertyAt(parsed, "location_slug")
      found.push({ ...(typeof slug === "string" ? { slug } : {}), available })
    }
  }
  if (found.length === 0) return undefined
  if (location !== undefined) {
    const match = [...found].reverse().find((entry) => entry.slug === location)
    if (match) return match.available
  }
  return found.every((entry) => entry.available)
}

