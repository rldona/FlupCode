import { describe, expect, it } from "bun:test"
import {
  dataUrlParts,
  findImageDataUrl,
  fingerprint,
  iftttPayload,
  imageUrlFromCloudinary,
  mapPreviewImage,
} from "./isobaria-publish"

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

describe("leer el data URL", () => {
  it("separa el mime del base64", () => {
    expect(dataUrlParts("data:image/png;base64,QUJD")).toEqual({ mime: "image/png", base64: "QUJD" })
  })

  it("devuelve undefined cuando no es un data URL base64", () => {
    expect(dataUrlParts("https://i.ibb.co/x.png")).toBeUndefined()
    expect(dataUrlParts("data:image/png,sin-base64")).toBeUndefined()
  })
})

describe("la respuesta de Cloudinary", () => {
  it("usa `secure_url`", () => {
    const payload = { secure_url: "https://res.cloudinary.com/demo/image/upload/v1/x.png" }
    expect(imageUrlFromCloudinary(payload)).toBe("https://res.cloudinary.com/demo/image/upload/v1/x.png")
  })

  it("cae a `url` si no hay `secure_url`", () => {
    const payload = { url: "http://res.cloudinary.com/demo/image/upload/v1/x.png" }
    expect(imageUrlFromCloudinary(payload)).toBe("http://res.cloudinary.com/demo/image/upload/v1/x.png")
  })

  it("devuelve undefined si no hay URL alguna", () => {
    expect(imageUrlFromCloudinary({ public_id: "x" })).toBeUndefined()
    expect(imageUrlFromCloudinary({})).toBeUndefined()
  })
})

describe("el payload de IFTTT", () => {
  it("lleva el texto, la imagen y el alt", () => {
    expect(iftttPayload({ text: "hola", imageUrl: "https://i.ibb.co/x.png", alt: "mapa" })).toEqual({
      value1: "hola",
      value2: "https://i.ibb.co/x.png",
      value3: "mapa",
    })
  })

  it("usa cadena vacía cuando no hay alt", () => {
    expect(iftttPayload({ text: "hola", imageUrl: "u" }).value3).toBe("")
  })
})

describe("la respuesta de Plazoleta", () => {
  it("lee la imagen y su alt", () => {
    const payload = { data: { status: "ok", image: "data:image/png;base64,QUJD", alt: "mapa" } }
    expect(mapPreviewImage(payload)).toEqual({
      status: "ok",
      degraded: undefined,
      image: { url: "data:image/png;base64,QUJD", alt: "mapa" },
    })
  })

  it("dice el motivo cuando no hay imagen", () => {
    expect(mapPreviewImage({ data: { status: "degraded", map_degraded: "no_source" } })).toEqual({
      status: "degraded",
      degraded: "no_source",
      image: undefined,
    })
  })

  it("no revienta con una respuesta vacía", () => {
    expect(mapPreviewImage({}).status).toBe("sin estado")
    expect(mapPreviewImage(null).image).toBeUndefined()
  })
})

describe("la huella del texto", () => {
  it("es estable para el mismo texto y distinta para otro", async () => {
    expect(await fingerprint("hola")).toBe(await fingerprint("hola"))
    expect(await fingerprint("hola")).not.toBe(await fingerprint("hola."))
  })
})
