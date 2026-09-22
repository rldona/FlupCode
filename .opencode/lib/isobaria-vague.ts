/**
 * El guard de la pieza vaga (PW-537), ahora del lado que publica.
 *
 * En Plazoleta este límite es conocido y deliberado: el validador no lo caza
 * porque la regla que lo cazaría —«desde datos exige una cifra rastreable»—
 * tumbaría también el registro honesto («hoy no lo sabemos»), y la diferencia
 * entre las dos frases no está en la forma sino en lo que afirman.
 *
 * Aquí no se toca el validador. Se pone una puerta **antes de publicar**: una
 * pieza de provincia que no traiga ancla —cifra, cita literal de AEMET, el
 * semáforo, o el registro de que no lo sabemos— no sale. No rechaza ni
 * corrige: para y dice por qué.
 *
 * Tres decisiones que no son obvias:
 *
 * · **Se exige el ancla, no se persigue la vaguedad.** En una pieza de
 *   provincia la decisión *siempre* lleva hora o umbral, o el aviso citado,
 *   o el registro honesto (`TAREAS-ISOBARIA.md`, tarea de las 12:00). Así que
 *   lo que falta es la señal, no la palabra: una frase vaga sin ningún
 *   fenómeno de la lista («se espera un día complicado») cae igual.
 *
 * · **La procedencia no sostiene nada.** La línea `📊 … 82/100 …` lleva cifras
 *   y no es un dato del fenómeno; contarla dejaría pasar la pieza vaga con
 *   solo añadir el pie. Por eso se evalúa el cuerpo sin las líneas de pie
 *   (`📊`) ni de enlace (`👉`).
 *
 * · **Las nacionales quedan fuera.** `panorama` y `alerts` describen el mapa
 *   —fenómenos y provincias— y no llevan cifras por diseño. Exigirles un
 *   ancla bloquearía la pieza legítima. Su rigor vive en la instrucción.
 */

/** El semáforo literal de AEMET: un aviso queda sostenido sin cifra ni cita. */
const LEVELS = /\b(amarillo|naranja|rojo)\b/

/** El registro honesto: no afirma, declara que no se sabe. Es lo que debe pasar. */
const UNCERTAINTY = [
  "no lo sabemos",
  "no sabemos",
  "no se sabe",
  "no se ponen de acuerdo",
  "los modelos no coinciden",
  "no coinciden",
  "discrepan",
  "no hay acuerdo",
  "sin acuerdo",
  "no esta claro",
  "no lo podemos saber",
  "no podemos saber",
  "no se puede saber",
  "no hay datos",
  "condicional",
  "si entra",
  "si llega",
] as const

/**
 * Fenómenos que se nombran para decir **qué** falta. No deciden el veredicto:
 * una pieza sin ancla cae tenga o no una de estas palabras.
 */
const PHENOMENA = [
  "calor",
  "frio",
  "lluvia",
  "lluvias",
  "llover",
  "llovera",
  "llueva",
  "llueve",
  "chubasco",
  "chubascos",
  "precipitacion",
  "precipitaciones",
  "nieve",
  "nevada",
  "nevadas",
  "viento",
  "vientos",
  "racha",
  "rachas",
  "tormenta",
  "tormentas",
  "temporal",
  "granizo",
  "niebla",
  "helada",
  "heladas",
  "nubes",
  "nublado",
  "cubierto",
  "despejado",
  "sol",
  "bochorno",
  "temperatura",
  "temperaturas",
] as const

const NATIONAL = new Set(["panorama", "alerts"])

/** Las dos únicas líneas que no son texto de nadie y por eso no cuentan. */
const BOILERPLATE = ["📊", "👉"]

const phenomenonPattern = new RegExp(`\\b(${PHENOMENA.join("|")})\\b`)

/** Sin acentos y en minúsculas: la pieza escribe «Frío» y la lista dice «frio». */
const normalize = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

const bodyOf = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !BOILERPLATE.some((prefix) => line.startsWith(prefix)))
    .join("\n")

const anchored = (body: string) =>
  /\d/.test(body) || /«[^»]+»/.test(body) || LEVELS.test(body) || UNCERTAINTY.some((phrase) => body.includes(phrase))

export type VagueVerdict =
  | { allow: true }
  | { allow: false; code: "EMPTY_POST" | "UNSUPPORTED_PHENOMENON"; reason: string; line?: string }

export function assessVaguePost(input: { text: string; template?: string }): VagueVerdict {
  const template = (input.template ?? "").trim().toLowerCase()
  // Una nacional no lleva cifras; su guard es la instrucción, no esto.
  if (NATIONAL.has(template)) return { allow: true }

  const body = bodyOf(input.text)
  if (!body) {
    return { allow: false, code: "EMPTY_POST", reason: "No hay texto que publicar." }
  }

  const normalized = normalize(body)
  if (anchored(normalized)) return { allow: true }

  const match = phenomenonPattern.exec(normalized)
  const missing = "sin una cifra, sin una cita literal de AEMET y sin declarar que no lo sabemos"
  return {
    allow: false,
    code: "UNSUPPORTED_PHENOMENON",
    reason: match
      ? `La pieza afirma «${match[1]}» ${missing}. Es la afirmación sin respaldo que Isobaria no publica.`
      : `La pieza no trae ${missing}: no hay nada que la sostenga.`,
    line: match ? body.split("\n").find((candidate) => phenomenonPattern.test(normalize(candidate))) : undefined,
  }
}
