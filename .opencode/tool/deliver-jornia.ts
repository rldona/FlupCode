import { tool } from "@opencode-ai/plugin"
import { findImageDataUrl, imageAttachment, propertyAt } from "../lib/piece-image"

/**
 * Entrega la pieza de Jornia que el modelo acaba de escribir y componer.
 *
 * No publica: recoge el PNG que ya compuso `compose_card` en esta sesión y
 * devuelve el texto, el alt y la tarjeta como adjunto, para que una persona los
 * copie y pegue juntos. A diferencia de `deliver-isobaria`, no lleva guardas de
 * tiempo ni de avisos: Jornia escribe desde material, y la última puerta —el
 * enlace y la longitud de Instagram, los vetados— ya la cierra `validate_piece`.
 */

export default tool({
  description: `Entrega la pieza de Jornia que acabas de escribir y componer para que una persona la copie y pegue a mano. No publica nada: recoge el PNG ya compuesto en esta sesión y devuelve el texto con su alt y la tarjeta, para que salgan juntos en este mismo paso.

Úsala **al final**, cuando el pie ya pasó \`plazoleta_validate_piece\` en verde y la tarjeta ya está compuesta con \`plazoleta_compose_card\`. La imagen se reemite aquí como adjunto, así que no la llames antes de componerla.

Si no encuentras la tarjeta en la conversación, no la inventes: dilo y llama antes a \`plazoleta_compose_card\`.`,
  args: {
    text: tool.schema.string().describe("El pie exacto de la pieza, tal y como se copia. Sin enlace si es Instagram."),
    template: tool.schema
      .string()
      .describe("La plantilla que se compuso con `compose_card`: square, portrait o landscape."),
    alt: tool.schema.string().optional().describe("El texto alternativo de la imagen, el que devolvió `compose_card`."),
  },
  async execute(args, ctx) {
    const messages = propertyAt(ctx, "messages")
    const imageDataUrl = findImageDataUrl(messages)
    if (!imageDataUrl) {
      return "No encuentro la tarjeta en la conversación. Llama antes a `plazoleta_compose_card` y vuelve a intentarlo."
    }

    const alt = args.alt ?? ""
    const output = [
      "Pieza lista para copiar y pegar. No se ha publicado nada.",
      "",
      "Texto:",
      args.text,
      "",
      alt ? `Alt de la imagen:\n${alt}` : "La imagen no trae alt.",
      "",
      "La tarjeta va con la pieza, aquí abajo: cópialas juntas.",
    ].join("\n")

    // La imagen se reemite como adjunto de esta entrega para que la pieza y su
    // tarjeta salgan juntas, en el mismo paso. Un `FilePart` necesita id y los
    // dos ids de sesión y mensaje; el host los da en el contexto.
    const attachment = imageAttachment(imageDataUrl)
    const sessionID = propertyAt(ctx, "sessionID")
    const messageID = propertyAt(ctx, "messageID")
    if (!attachment || typeof sessionID !== "string" || typeof messageID !== "string") return output
    return {
      output,
      attachments: [{ id: `prt_${crypto.randomUUID()}`, sessionID, messageID, ...attachment }],
    }
  },
})
