import { describe, expect, it } from "bun:test"
import deliver from "../tool/deliver-isobaria"
import { alertsAvailability, assessAlertsClaim } from "./isobaria-deliver"
import { findImageDataUrl, imageAttachment } from "./piece-image"

const png = (marker: string) => `data:image/png;base64,${marker}`

describe("encontrar el PNG que compuso el MCP", () => {
  it("lo lee de los adjuntos del estado de la tool, que es donde queda", () => {
    const messages = [
      { parts: [{ type: "text", text: "hola" }] },
      {
        parts: [
          {
            type: "tool",
            tool: "plazoleta:compose_map",
            state: { attachments: [{ type: "file", mime: "image/png", url: png("mapa") }] },
          },
        ],
      },
    ]
    expect(findImageDataUrl(messages)).toBe(png("mapa"))
  })

  it("se queda con el último, que es el del flujo", () => {
    const messages = [
      { parts: [{ type: "tool", state: { attachments: [{ type: "file", mime: "image/png", url: png("viejo") }] } }] },
      { parts: [{ type: "tool", state: { attachments: [{ type: "file", mime: "image/png", url: png("nuevo") }] } }] },
    ]
    expect(findImageDataUrl(messages)).toBe(png("nuevo"))
  })

  it("ignora lo que no es una imagen en data URL", () => {
    const messages = [
      {
        parts: [
          {
            type: "tool",
            state: { attachments: [{ type: "file", mime: "text/plain", url: "data:text/plain;base64,QQ==" }] },
          },
        ],
      },
      { parts: [{ type: "file", mime: "image/png", url: "https://i.ibb.co/x.png" }] },
    ]
    expect(findImageDataUrl(messages)).toBeUndefined()
  })

  it("no revienta con formas inesperadas", () => {
    expect(findImageDataUrl(undefined)).toBeUndefined()
    expect(findImageDataUrl([{}])).toBeUndefined()
    expect(findImageDataUrl([{ parts: "nope" }])).toBeUndefined()
  })
})

describe("el mapa como adjunto de la entrega", () => {
  it("convierte un data URL de imagen en un adjunto de fichero", () => {
    expect(imageAttachment(png("mapa"))).toEqual({ type: "file", mime: "image/png", url: png("mapa") })
  })

  it("no reemite lo que no es una imagen en base64", () => {
    expect(imageAttachment("data:text/plain;base64,QQ==")).toBeUndefined()
    expect(imageAttachment("https://i.ibb.co/x.png")).toBeUndefined()
    expect(imageAttachment("data:image/png,sin-base64")).toBeUndefined()
  })
})

describe("la pieza no cita avisos que no se pudieron consultar", () => {
  const weatherPart = (payload: Record<string, unknown>, tool = "plazoleta_get_weather") => ({
    type: "tool",
    tool,
    state: { output: JSON.stringify(payload) },
  })

  it("deja pasar la pieza cuando los avisos se consultaron o no consta", () => {
    expect(assessAlertsClaim({ text: "Aviso naranja por calor.", alertsAvailable: true })).toEqual({ allow: true })
    expect(assessAlertsClaim({ text: "Sin avisos hoy.", alertsAvailable: undefined })).toEqual({ allow: true })
  })

  it("para una pieza que cita un nivel o afirma que no hay avisos", () => {
    expect(assessAlertsClaim({ text: "Sevilla en naranja desde las 13:00.", alertsAvailable: false }).allow).toBe(false)
    expect(assessAlertsClaim({ text: "Hoy no hay avisos.", alertsAvailable: false }).allow).toBe(false)
    expect(assessAlertsClaim({ text: "Sin ninguna alerta.", alertsAvailable: false }).allow).toBe(false)
  })

  it("deja pasar una pieza que no habla de avisos aunque no se consultaran", () => {
    expect(assessAlertsClaim({ text: "Máxima de 28 °C a las 15:00.", alertsAvailable: false })).toEqual({ allow: true })
  })

  it("lee la disponibilidad de la sesión y la del municipio pedido", () => {
    const messages = [
      { parts: [weatherPart({ location_slug: "madrid", alerts_available: true })] },
      { parts: [weatherPart({ location_slug: "bilbao", alerts_available: false })] },
    ]
    expect(alertsAvailability(messages, "madrid")).toBe(true)
    expect(alertsAvailability(messages, "bilbao")).toBe(false)
    // Sin coincidencia de municipio, cualquier caída basta.
    expect(alertsAvailability(messages, "sevilla")).toBe(false)
    expect(alertsAvailability(messages)).toBe(false)
  })

  it("no inventa disponibilidad cuando no hay salidas que lo digan", () => {
    expect(alertsAvailability([{ parts: [{ type: "text", text: "hola" }] }])).toBeUndefined()
    expect(alertsAvailability([{ parts: [weatherPart({ location_slug: "madrid" })] }])).toBeUndefined()
    expect(alertsAvailability(undefined)).toBeUndefined()
  })
})

describe("el execute del tool: el orden de las puertas y lo que dice al parar", () => {
  type ToolContext = Parameters<typeof deliver.execute>[1]

  // El host entrega `messages` dentro del contexto y el tool lo lee con
  // `propertyAt`, pero el tipo del plugin no declara ese campo. Se pasa el
  // contexto mínimo que `execute` consume, sin reproducir nada de la lógica
  // que se prueba. No hay `globalThis` ni dobles: es la implementación real.
  const ctx = (messages: unknown[], ids: { sessionID?: string; messageID?: string } = {}) =>
    ({ messages, ...ids }) as unknown as ToolContext

  const run = async (args: Parameters<typeof deliver.execute>[0], messages: unknown[]) => {
    const result = await deliver.execute(args, ctx(messages))
    return typeof result === "string" ? result : result.output
  }

  const png = (marker: string) => `data:image/png;base64,${marker}`
  const withParts = (parts: unknown[]) => [{ parts }]
  const composeMap = (url: string) => ({
    type: "tool",
    tool: "plazoleta:compose_map",
    state: { attachments: [{ type: "file", mime: "image/png", url }] },
  })
  const getWeather = (payload: Record<string, unknown>) => ({
    type: "tool",
    tool: "plazoleta_get_weather",
    state: { output: JSON.stringify(payload) },
  })

  it("entrega el texto con su alt cuando el mapa ya está compuesto", async () => {
    const output = await run(
      { text: "Máxima de 28 °C a las 15:00.", template: "rain", alt: "Mapa de lluvia en Madrid", location: "madrid" },
      withParts([getWeather({ location_slug: "madrid", alerts_available: true }), composeMap(png("mapa"))]),
    )
    expect(output).toContain("Pieza lista para copiar y pegar. No se ha publicado nada.")
    expect(output).toContain("Máxima de 28 °C a las 15:00.")
    expect(output).toContain("Alt de la imagen:\nMapa de lluvia en Madrid")
  })

  it("reemite el mapa como adjunto para que salga junto al post", async () => {
    const result = await deliver.execute(
      { text: "Máxima de 28 °C a las 15:00.", template: "rain", location: "madrid" },
      ctx(withParts([getWeather({ location_slug: "madrid", alerts_available: true }), composeMap(png("mapa"))]), {
        sessionID: "ses_x",
        messageID: "msg_x",
      }),
    )
    expect(typeof result).toBe("object")
    const attachments = (result as { attachments?: Array<Record<string, unknown>> }).attachments ?? []
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      type: "file",
      mime: "image/png",
      url: png("mapa"),
      sessionID: "ses_x",
      messageID: "msg_x",
    })
    expect(String(attachments[0]?.id)).toStartWith("prt")
  })

  it("sin los ids de sesión y mensaje, devuelve solo el texto", async () => {
    const result = await deliver.execute(
      { text: "Máxima de 28 °C a las 15:00.", template: "rain", location: "madrid" },
      ctx(withParts([getWeather({ location_slug: "madrid", alerts_available: true }), composeMap(png("mapa"))])),
    )
    expect(typeof result).toBe("string")
    expect(String(result)).toContain("Pieza lista para copiar y pegar.")
  })

  it("la puerta de la pieza vaga va antes que la de los avisos", async () => {
    const output = await run(
      { text: "Hay avisos.", template: "rain" },
      withParts([getWeather({ location_slug: "madrid", alerts_available: false })]),
    )
    expect(output).toStartWith("No se entrega. UNSUPPORTED_PHENOMENON:")
    expect(output).not.toContain("ALERTS_UNAVAILABLE_CLAIM")
  })

  it("la puerta de los avisos va antes que la búsqueda de la imagen", async () => {
    const output = await run(
      { text: "Aviso naranja en Madrid a las 13:00.", template: "rain", location: "madrid" },
      withParts([getWeather({ location_slug: "madrid", alerts_available: false })]),
    )
    expect(output).toStartWith("No se entrega. ALERTS_UNAVAILABLE_CLAIM:")
    expect(output).not.toContain("No encuentro la imagen")
  })

  it("sin imagen compuesta en la sesión, para y lo dice", async () => {
    const output = await run(
      { text: "Máxima de 28 °C a las 15:00.", template: "rain", location: "madrid" },
      withParts([getWeather({ location_slug: "madrid", alerts_available: true })]),
    )
    expect(output).toBe(
      "No encuentro la imagen del mapa en la conversación. Llama antes a `compose_map` y vuelve a intentarlo.",
    )
  })

  it("dice que la imagen no trae alt cuando no se pasa", async () => {
    const output = await run(
      { text: "Máxima de 28 °C a las 15:00.", template: "rain", location: "madrid" },
      withParts([composeMap(png("mapa"))]),
    )
    expect(output).toContain("La imagen no trae alt.")
    expect(output).not.toContain("Alt de la imagen:")
  })
})
