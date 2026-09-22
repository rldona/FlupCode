import { describe, expect, it } from "bun:test"
import { assessVaguePost } from "./isobaria-vague"

// Los dos casos exactos de la tanda de Plazoleta (`app/evals/mcp.py`).
const VAGUE = "Mañana hará mucho calor en Valencia."
const HONEST = "Los modelos no se ponen de acuerdo sobre el sábado en Bilbao. Hoy no lo sabemos."

const blocked = (verdict: ReturnType<typeof assessVaguePost>) => (!verdict.allow ? verdict.code : undefined)

describe("la pieza vaga", () => {
  it("para la afirmación sin cifra, sin cita y sin registro", () => {
    expect(blocked(assessVaguePost({ text: VAGUE, template: "heat" }))).toBe("UNSUPPORTED_PHENOMENON")
  })

  it("caza la vaguedad que no usa ninguna palabra de la lista", () => {
    expect(blocked(assessVaguePost({ text: "Se espera un día complicado.", template: "heat" }))).toBe(
      "UNSUPPORTED_PHENOMENON",
    )
  })

  it("deja pasar el registro honesto, que es texto sin cifras y es legítimo", () => {
    expect(assessVaguePost({ text: HONEST, template: "rain" })).toEqual({ allow: true })
  })

  it("no se apoya en la línea de procedencia", () => {
    const text = `${VAGUE}\n📊 Índice de acuerdo entre modelos · 82/100 · ECMWF, ICON y GFS`
    expect(blocked(assessVaguePost({ text, template: "heat" }))).toBe("UNSUPPORTED_PHENOMENON")
  })

  it("no se apoya en la línea del enlace", () => {
    const text = `${VAGUE}\n👉 https://isobaria.com/x/es/tiempo/valencia`
    expect(blocked(assessVaguePost({ text, template: "heat" }))).toBe("UNSUPPORTED_PHENOMENON")
  })

  it("deja pasar la decisión con su cifra", () => {
    const text = "Mañana lloverá en Valencia a partir de las 18:00.\n📊 Índice de acuerdo entre modelos · 82/100"
    expect(assessVaguePost({ text, template: "rain" })).toEqual({ allow: true })
  })

  it("deja pasar el aviso citado literal y el semáforo de AEMET", () => {
    const quoted = "Aviso naranja por tormentas en Valencia. «Temperatura máxima: 40 ºC»."
    expect(assessVaguePost({ text: quoted, template: "heat" })).toEqual({ allow: true })
    const leveled = "Avisos amarillo en la provincia de Valencia; «Tormentas»."
    expect(assessVaguePost({ text: leveled, template: "rain" })).toEqual({ allow: true })
  })

  it("nombra el fenómeno cuando lo reconoce, y no cuando solo lo contiene", () => {
    const named = assessVaguePost({ text: VAGUE, template: "heat" })
    expect(named.allow).toBe(false)
    if (named.allow) return
    expect(named.reason.includes("calor")).toBe(true)

    const contained = assessVaguePost({ text: "Las calorías del menú no son el tiempo.", template: "heat" })
    expect(contained.allow).toBe(false)
    if (contained.allow) return
    expect(contained.reason.includes("calor")).toBe(false)
  })

  it("no distingue acentos: «FRÍO» es el mismo fenómeno que «frio»", () => {
    expect(blocked(assessVaguePost({ text: "Mañana hará mucho FRÍO en Valencia.", template: "heat" }))).toBe(
      "UNSUPPORTED_PHENOMENON",
    )
  })

  it("no publica un texto vacío", () => {
    expect(blocked(assessVaguePost({ text: "   \n👉 isobaria.com", template: "rain" }))).toBe("EMPTY_POST")
  })
})

describe("las nacionales quedan fuera del guard", () => {
  it("el panorama describe el mapa sin cifras y pasa", () => {
    expect(assessVaguePost({ text: "Lluvia en el norte; despejado en el resto.", template: "panorama" })).toEqual({
      allow: true,
    })
  })

  it("el mapa de avisos pasa igual", () => {
    expect(
      assessVaguePost({ text: "Avisos naranja en Andalucía occidental; el resto, amarillo.", template: "alerts" }),
    ).toEqual({ allow: true })
  })
})
