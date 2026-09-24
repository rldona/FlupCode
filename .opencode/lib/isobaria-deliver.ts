/**
 * Las piezas puras propias de `deliver-isobaria`: decidir si la pieza puede
 * salir y leer la disponibilidad de avisos. Sin red y sin ficheros, para poder
 * probarlas. Lo genérico de la imagen vive en `piece-image.ts`, compartido con
 * `deliver-jornia`.
 */

import { propertyAt } from "./piece-image"

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

