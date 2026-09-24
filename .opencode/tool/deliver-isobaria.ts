import { tool } from "@opencode-ai/plugin"
import { alertsAvailability, assessAlertsClaim } from "../lib/isobaria-deliver"
import { assessVaguePost } from "../lib/isobaria-vague"
import { findImageDataUrl, imageAttachment, propertyAt } from "../lib/piece-image"

/**
 * Entrega la pieza de Isobaria que el modelo acaba de escribir y componer.
 *
 * No publica: recoge el PNG que ya compuso `compose_map` en esta sesión y
 * devuelve el texto, el alt y el mapa como adjunto, para que una persona los
 * copie y pegue juntos. Los guards de la pieza vaga y de los avisos no
 * consultados siguen delante.
 */

export default tool({
  description: `Entrega la pieza de Isobaria que acabas de escribir y componer para que una persona la copie y pegue a mano. No publica nada: recoge el PNG ya compuesto en esta sesión y devuelve el texto con su alt y el mapa, para que salgan juntos en este mismo paso.

Úsala **al final**, cuando el texto ya pasó \`validate_piece\` en verde y la imagen ya está compuesta con \`compose_map\`. La imagen se reemite aquí como adjunto, así que no la llames antes de componerla.

No entrega una pieza vaga: si el texto de una plantilla de provincia no trae cifra, ni cita literal de AEMET, ni el registro de que no lo sabemos, para y lo dice. No la reescribe.

Tampoco entrega una pieza que cite un aviso de AEMET o afirme que no los hay cuando la capa de avisos no se pudo consultar: eso es «no lo sabemos», no «hoy no hay».`,
  args: {
    text: tool.schema.string().describe("El texto exacto de la pieza, con su línea de enlace, tal y como se copia."),
    template: tool.schema
      .string()
      .describe("La plantilla que se compuso: rain, wind, heat, sun, panorama, alerts o card."),
    alt: tool.schema.string().optional().describe("El texto alternativo de la imagen, si lo tienes."),
    location: tool.schema.string().optional().describe("El slug del municipio de la pieza, para comprobar los avisos."),
  },
  async execute(args, ctx) {
    const verdict = assessVaguePost({ text: args.text, template: args.template })
    if (!verdict.allow) {
      return `No se entrega. ${verdict.code}: ${verdict.reason}`
    }

    // Los avisos que no se pudieron consultar no se citan ni se dan por
    // ausentes. Se lee de la salida de `get_weather` de esta sesión.
    const messages = propertyAt(ctx, "messages")
    const alertsVerdict = assessAlertsClaim({
      text: args.text,
      alertsAvailable: alertsAvailability(messages, args.location),
    })
    if (!alertsVerdict.allow) {
      return `No se entrega. ${alertsVerdict.code}: ${alertsVerdict.reason}`
    }

    const imageDataUrl = findImageDataUrl(messages)
    if (!imageDataUrl) {
      return "No encuentro la imagen del mapa en la conversación. Llama antes a `compose_map` y vuelve a intentarlo."
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
      "El mapa va con la pieza, aquí abajo: cópialos juntos.",
    ].join("\n")

    // La imagen se reemite como adjunto de esta entrega para que la pieza y su
    // mapa salgan juntos, en el mismo paso. Un `FilePart` necesita id y los dos
    // ids de sesión y mensaje; el host los da en el contexto.
    const attachment = imageAttachment(imageDataUrl)
    const sessionID = propertyAt(ctx, "sessionID")
    const messageID = propertyAt(ctx, "messageID")
    if (!attachment || typeof sessionID !== "string" || typeof messageID !== "string") return output
    return {
      output,
      attachments: [
        { id: `prt_${crypto.randomUUID()}`, sessionID, messageID, ...attachment },
      ],
    }
  },
})
