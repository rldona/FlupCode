/**
 * Las piezas puras que necesita cualquier entrega de pieza con imagen: el PNG
 * compuesto por el MCP en la sesión y el adjunto para reemitirlo. Sin red y
 * sin ficheros, para poder probarlas. Las comparten `deliver-isobaria` (mapa) y
 * `deliver-jornia` (tarjeta).
 *
 * De dónde sale la imagen, que no es obvio: una tool del MCP que devuelve una
 * imagen no deja un `FilePart` suelto en el mensaje. El adjunto queda dentro
 * del estado de la tool que la produjo (`ToolStateCompleted.attachments`,
 * `session.ts:288`), así que hay que mirar ahí y quedarse con el último: el
 * flujo es `compose_map`/`compose_card` y después esto. El PNG se lee solo para
 * confirmar que está en la sesión; no se sube ni se publica.
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
 * El data URL de la imagen como adjunto de tool, para que la entrega lleve la
 * imagen junto al texto. Solo imágenes: lo que no lo sea no se reemite.
 */
export function imageAttachment(dataUrl: string): { type: "file"; mime: string; url: string } | undefined {
  const mime = /^data:([^;,]+);base64,/.exec(dataUrl)?.[1]
  if (!mime || !mime.startsWith("image/")) return undefined
  return { type: "file", mime, url: dataUrl }
}

/** Un campo de un valor de fuera, sin aserciones ni suposiciones. */
export const propertyAt = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
