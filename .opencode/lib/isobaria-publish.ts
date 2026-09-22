/**
 * Las piezas puras de `publish-isobaria`: encontrar el PNG, leer la respuesta
 * de Cloudinary y la de Plazoleta, y componer el payload de IFTTT. Sin red y sin
 * ficheros, para poder probarlas.
 *
 * De dónde sale la imagen, que no es obvio: una tool del MCP que devuelve una
 * imagen no deja un `FilePart` suelto en el mensaje. El adjunto queda dentro
 * del estado de la tool que la produjo (`ToolStateCompleted.attachments`,
 * `session.ts:288`), así que hay que mirar ahí y quedarse con el último: el
 * flujo es `compose_map` y después esto.
 *
 * Todo lo que llega de fuera se lee con `propertyAt` en vez de con aserciones:
 * son respuestas de red y del host, y una aserción no comprueba nada.
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

/** `data:image/png;base64,…` → sus dos mitades, o `undefined` si no lo es. */
export function dataUrlParts(url: string): { mime: string; base64: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url)
  if (!match) return undefined
  const [, mime, base64] = match
  if (mime === undefined || base64 === undefined) return undefined
  return { mime, base64 }
}

/** Un campo de un valor de fuera, sin aserciones ni suposiciones. */
export const propertyAt = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

/** La URL pública del PNG en la respuesta de Cloudinary, o `undefined`.
 *
 * `secure_url` es la https que se le pasa a IFTTT; `url` queda de respaldo por
 * si la forma cambia.
 */
export function imageUrlFromCloudinary(payload: unknown): string | undefined {
  const secure = propertyAt(payload, "secure_url")
  if (typeof secure === "string" && secure) return secure
  const fallback = propertyAt(payload, "url")
  return typeof fallback === "string" && fallback ? fallback : undefined
}

/** Lo que se puede decir de `POST /content/map-preview`: el PNG, o el motivo. */
export function mapPreviewImage(payload: unknown) {
  const data = propertyAt(payload, "data")
  const status = propertyAt(data, "status")
  const degraded = propertyAt(data, "map_degraded")
  const url = propertyAt(data, "image")
  const alt = propertyAt(data, "alt")
  return {
    status: typeof status === "string" ? status : "sin estado",
    degraded: typeof degraded === "string" ? degraded : undefined,
    image: typeof url === "string" && url ? { url, alt: typeof alt === "string" && alt ? alt : undefined } : undefined,
  }
}

/** El cuerpo que espera el Webhooks de IFTTT. */
export const iftttPayload = (input: { text: string; imageUrl: string; alt?: string }) => ({
  value1: input.text,
  value2: input.imageUrl,
  value3: input.alt ?? "",
})

/** La huella del texto, para no publicar dos veces la misma pieza el mismo día. */
export async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
