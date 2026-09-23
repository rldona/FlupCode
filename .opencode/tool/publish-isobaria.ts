/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { assessVaguePost } from "../lib/isobaria-vague"
import {
  alertsAvailability,
  assessAlertsClaim,
  dataUrlParts,
  findImageDataUrl,
  fingerprint,
  iftttPayload,
  imageUrlFromCloudinary,
  mapPreviewImage,
  propertyAt,
} from "../lib/isobaria-publish"

/**
 * Publica la pieza de Isobaria que el modelo acaba de escribir y componer.
 *
 * Es el último tramo del camino que en Plazoleta no existe a propósito
 * (ADR-0023): aquí sí se publica, y por eso lleva el guard de la pieza vaga
 * delante. La imagen no la compone esta tool: la compuso `compose_map`, y aquí
 * solo se recoge para subirla a Cloudinary y entregársela a IFTTT.
 */

/**
 * Los valores del `.env` de la raíz del repo, además de `process.env`.
 *
 * Bun carga ese `.env` al arrancar el engine, pero un engine que ya estaba en
 * marcha cuando se creó el fichero no lo tiene en `process.env`, y reiniciarlo
 * no siempre está en nuestra mano. Leerlo aquí pone las variables donde se
 * esperan sin depender del arranque.
 */
const dotenv = (() => {
  try {
    const text = readFileSync(fileURLToPath(new URL("../../.env", import.meta.url)), "utf8")
    const values: Record<string, string> = {}
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
      if (match === null) continue
      const [, key, value] = match
      if (key !== undefined && value !== undefined) values[key] = value.trim().replace(/^["']|["']$/g, "")
    }
    return values
  } catch {
    return {}
  }
})()

const setting = (name: string) => process.env[name]?.trim() || dotenv[name] || ""

const required = (name: string) => {
  const value = setting(name)
  if (!value) throw new Error(`Falta ${name}: sin ella no se puede publicar.`)
  return value
}

const stateDirectory = () =>
  process.env.ISOBARIA_PUBLISH_STATE ??
  join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "isobaria-publish")

const stateFile = () => join(stateDirectory(), `${new Date().toISOString().slice(0, 10)}.json`)

const publishedToday = async (): Promise<string[]> => {
  // Un fichero que aún no existe es el caso normal del primer post del día.
  try {
    const parsed = JSON.parse(await readFile(stateFile(), "utf8"))
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

const remember = async (id: string) => {
  const list = await publishedToday()
  if (list.includes(id)) return
  await mkdir(stateDirectory(), { recursive: true })
  await writeFile(stateFile(), JSON.stringify([...list, id]))
}

const uploadToCloudinary = async (image: { mime: string; base64: string }) => {
  const cloud = required("CLOUDINARY_CLOUD_NAME")
  const extension = image.mime.split("/")[1] ?? "png"
  const body = new FormData()
  // El PNG va como fichero, no como data URI: Cloudinary rechaza `data:` en
  // `file` ("Unsupported source URL") con un preset unsigned.
  body.append("file", new File([Buffer.from(image.base64, "base64")], `isobaria.${extension}`, { type: image.mime }))
  body.append("upload_preset", required("CLOUDINARY_UPLOAD_PRESET"))
  const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/image/upload`, {
    method: "POST",
    body,
  })
  if (!response.ok) throw new Error(`Cloudinary respondió ${response.status}: ${await response.text()}`)
  const url = imageUrlFromCloudinary(await response.json())
  if (!url) throw new Error("Cloudinary no devolvió una URL de imagen.")
  return url
}

const postToIfttt = async (values: ReturnType<typeof iftttPayload>) => {
  const event = setting("IFTTT_EVENT") || "isobaria_post"
  const url = `https://maker.ifttt.com/trigger/${encodeURIComponent(event)}/with/key/${encodeURIComponent(required("IFTTT_WEBHOOK_KEY"))}`
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(values),
  })
  if (!response.ok) throw new Error(`IFTTT respondió ${response.status}: ${await response.text()}`)
}

/**
 * El plan B: componer el mapa por el REST de Plazoleta. Solo se intenta si el
 * PNG no estaba en la sesión y las tres variables están declaradas.
 */
const composeViaRest = async (template: string, location?: string) => {
  const base = setting("PLAZOLETA_BASE_URL").replace(/\/$/, "")
  const token = setting("PLAZOLETA_TOKEN")
  const productID = setting("PLAZOLETA_PRODUCT_ID")
  if (!base || !token || !productID) return undefined

  const response = await fetch(`${base}/api/v1/content/map-preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ product_id: productID, location: location ?? null, map_template: template }),
  })
  if (!response.ok) throw new Error(`Plazoleta respondió ${response.status}: ${await response.text()}`)

  const preview = mapPreviewImage(await response.json())
  if (!preview.image) {
    const why = preview.degraded ? `: ${preview.degraded}` : ""
    throw new Error(`Plazoleta no compuso el mapa (${preview.status}${why}).`)
  }
  return preview.image
}

export default tool({
  description: `Publica en X la pieza de Isobaria que acabas de escribir y componer.

Úsala **al final**, cuando el texto ya pasó \`validate_piece\` en verde y la imagen ya está compuesta con \`compose_map\`. Recoge ese PNG de la conversación, así que no la llames antes de componerlo.

No publica una pieza vaga: si el texto de una plantilla de provincia no trae cifra, ni cita literal de AEMET, ni el registro de que no lo sabemos, para y lo dice. No la reescribe.

Tampoco publica una pieza que cite un aviso de AEMET o afirme que no los hay cuando la capa de avisos no se pudo consultar: eso es «no lo sabemos», no «hoy no hay».

El texto va tal cual, con su enlace. La imagen y el texto no se pegan: se publican juntos.`,
  args: {
    text: tool.schema.string().describe("El texto exacto del post, con su línea de enlace, tal y como se publica."),
    template: tool.schema
      .string()
      .describe("La plantilla del mapa que se compuso: rain, wind, heat, sun, panorama o alerts."),
    alt: tool.schema.string().optional().describe("El texto alternativo de la imagen, si lo tienes."),
    location: tool.schema.string().optional().describe("El slug del municipio, solo para la composición de respaldo."),
    dry_run: tool.schema.boolean().optional().describe("Comprueba guard e imagen sin subir nada ni publicar."),
  },
  async execute(args, ctx) {
    const verdict = assessVaguePost({ text: args.text, template: args.template })
    if (!verdict.allow) {
      return `No se publica. ${verdict.code}: ${verdict.reason}`
    }

    // Los avisos que no se pudieron consultar no se citan ni se dan por
    // ausentes. Se lee de la salida de `get_weather` de esta sesión.
    const messages = propertyAt(ctx, "messages")
    const alertsVerdict = assessAlertsClaim({
      text: args.text,
      alertsAvailable: alertsAvailability(messages, args.location),
    })
    if (!alertsVerdict.allow) {
      return `No se publica. ${alertsVerdict.code}: ${alertsVerdict.reason}`
    }

    const id = await fingerprint(args.text)
    if ((await publishedToday()).includes(id)) {
      return "Esta misma pieza ya se publicó hoy; no se repite."
    }

    await ctx.ask({
      permission: "publish-isobaria",
      patterns: ["*"],
      always: ["*"],
      metadata: { template: args.template, dry_run: args.dry_run ?? false },
    })

    let imageDataUrl = findImageDataUrl(messages)
    let alt = args.alt ?? ""
    if (!imageDataUrl) {
      const viaRest = await composeViaRest(args.template, args.location)
      if (!viaRest) {
        return "No encuentro la imagen del mapa en la conversación. Llama antes a `compose_map` y vuelve a intentarlo."
      }
      imageDataUrl = viaRest.url
      alt = alt || viaRest.alt || ""
    }

    const parts = dataUrlParts(imageDataUrl)
    if (!parts) throw new Error("La imagen del mapa no es un data URL en base64.")

    if (args.dry_run) {
      return `Dry run: guard en verde, imagen ${parts.mime} lista${alt ? ` (alt «${alt}»)` : ""}. No se ha publicado nada.`
    }

    const imageUrl = await uploadToCloudinary(parts)
    await postToIfttt(iftttPayload({ text: args.text, imageUrl, alt }))
    await remember(id)
    return `Publicado en X. Imagen en ${imageUrl}`
  },
})
