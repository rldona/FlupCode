/**
 * The PDFs the engine refuses, and the ones it can be handed after unlocking.
 *
 * OpenCode answers "encrypted PDFs are not supported" when a turn carries one, and the failure
 * sticks: the file stays in the conversation, so every later turn fails the same way. Attachments
 * arrive as data URLs, so the trailer is checked here, before the file reaches the composer or the
 * engine.
 *
 * Most bank statements are only permission-encrypted: the user password is empty, and any reader
 * opens them without asking. For those, `unlockPdf` removes the encryption in place — RC4 keeps
 * every byte where it was, so the cross-reference table stays valid and no rewrite is needed — and
 * the composer attaches the readable copy. A file that needs a real password is still refused.
 */
export function isEncryptedPdf(file: { uri: string; name: string }) {
  if (!/\.pdf$/i.test(file.name) && !file.uri.startsWith("data:application/pdf")) return false
  const comma = file.uri.indexOf(",")
  if (comma < 0) return false
  const header = file.uri.slice(0, comma)
  const payload = file.uri.slice(comma + 1)
  try {
    const bytes = header.includes(";base64") ? decodeBase64Tail(payload) : decodeURIComponent(payload)
    return bytes.includes("/Encrypt")
  } catch {
    // Not something this check can read: let the engine say what it is instead of failing here.
    return false
  }
}

export type PdfUnlock = { ok: true; bytes: Uint8Array } | { ok: false; reason: "password" | "unsupported" }

/** The bytes behind an attachment's data URL. */
export function pdfBytes(uri: string) {
  const comma = uri.indexOf(",")
  if (comma < 0) return undefined
  const payload = uri.slice(comma + 1)
  try {
    if (uri.slice(0, comma).includes(";base64")) return base64Bytes(payload)
    return new TextEncoder().encode(decodeURIComponent(payload))
  } catch {
    return undefined
  }
}

export function pdfDataUrl(bytes: Uint8Array) {
  return `data:application/pdf;base64,${base64Text(bytes)}`
}

function base64Bytes(text: string) {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function base64Text(bytes: Uint8Array) {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** The padding every standard security handler hashes the password with (PDF 32000-1, 7.6.3.3). */
const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
])

/**
 * Opens a PDF that carries `/Encrypt` with an empty user password and returns a copy without it.
 * Only the RC4 handlers are unlocked (V1/V2, revisions 2 to 4): they keep each byte in place, so
 * the file is edited where it stands. AES re-pads its streams and would need a rewrite.
 */
export function unlockPdf(input: Uint8Array): PdfUnlock {
  const bytes = input.slice()
  const xref = readXref(bytes)
  if (!xref?.encrypt) return { ok: false, reason: "unsupported" }

  const encryptEntry = xref.entries.get(xref.encrypt.number)
  if (!encryptEntry) return { ok: false, reason: "unsupported" }
  const encrypt = objectDictAt(bytes, encryptEntry.offset)
  if (!encrypt) return { ok: false, reason: "unsupported" }
  const version = Number(textOf(encrypt, "/V") ?? 0)
  const revision = Number(textOf(encrypt, "/R") ?? 0)
  if (textOf(encrypt, "/Filter") !== "/Standard" || (version !== 1 && version !== 2) || revision < 2)
    return { ok: false, reason: "unsupported" }

  const owner = bytesOf(encrypt, "/O")
  const user = bytesOf(encrypt, "/U")
  const permissions = Number(textOf(encrypt, "/P") ?? 0)
  const length = Number(textOf(encrypt, "/Length") ?? 40)
  if (!owner || !user || !xref.id) return { ok: false, reason: "unsupported" }

  const size = revision === 2 ? 5 : Math.min(16, Math.max(5, Math.floor(length / 8)))
  const key = fileKey(owner, permissions, xref.id, revision, size, encrypt)
  if (!authenticates(key, user, xref.id, revision)) return { ok: false, reason: "password" }

  for (const [number, entry] of xref.entries) {
    if (number === xref.encrypt.number) continue
    decryptObject(bytes, entry.offset, number, entry.gen, key, size)
  }
  for (const trailer of xref.trailers) blankEncrypt(bytes, trailer.start, trailer.end)
  return { ok: true, bytes }
}

/* ------------------------------------------------------------------ xref and dictionaries */

type Ref = { number: number; gen: number }
type Entry = { offset: number; gen: number }
type Xref = { entries: Map<number, Entry>; trailers: Array<{ start: number; end: number }>; encrypt?: Ref; id?: Uint8Array }
type Dict = Map<string, string | Uint8Array>

function readXref(bytes: Uint8Array): Xref | undefined {
  const entries = new Map<number, Entry>()
  const trailers: Array<{ start: number; end: number }> = []
  let offset = lastStartXref(bytes)
  for (let guard = 0; offset >= 0 && guard < 64; guard++) {
    const section = readSection(bytes, offset)
    if (!section) return undefined
    for (const [number, entry] of section.entries) if (!entries.has(number)) entries.set(number, entry)
    trailers.push({ start: section.trailerStart, end: section.trailerEnd })
    const prev = section.prev
    offset = prev === undefined ? -1 : prev
  }
  if (entries.size === 0) return undefined

  // The newest trailer is the one that counts; the older ones are walked only for their objects.
  const dict = readDictAt(bytes, trailers[0]!.start)
  if (!dict) return undefined
  return { entries, trailers, encrypt: refOf(dict.get("/Encrypt")), id: bytesOf(dict, "/ID") }
}

function lastStartXref(bytes: Uint8Array) {
  const at = lastIndexOf(bytes, "startxref")
  if (at < 0) return -1
  const number = readInt(bytes, skipWs(bytes, at + 9))
  return number ? number.value : -1
}

function readSection(bytes: Uint8Array, offset: number) {
  if (!matches(bytes, offset, "xref")) return undefined
  const entries = new Map<number, Entry>()
  let p = offset + 4
  for (;;) {
    p = skipWs(bytes, p)
    if (matches(bytes, p, "trailer")) break
    const start = readInt(bytes, p)
    if (!start) return undefined
    p = skipWs(bytes, start.end)
    const count = readInt(bytes, p)
    if (!count) return undefined
    p = count.end
    for (let i = 0; i < count.value; i++) {
      p = skipWs(bytes, p)
      const at = readInt(bytes, p)
      if (!at) return undefined
      p = skipWs(bytes, at.end)
      const gen = readInt(bytes, p)
      if (!gen) return undefined
      p = skipWs(bytes, gen.end)
      const type = bytes[p]
      p += 1
      if (type === 0x6e) entries.set(start.value + i, { offset: at.value, gen: gen.value })
    }
  }
  const trailerStart = skipWs(bytes, p + 7)
  const dict = readDictAt(bytes, trailerStart)
  const prev = dict ? Number(textOf(dict, "/Prev") ?? NaN) : NaN
  return { entries, trailerStart, trailerEnd: dictEnd(bytes, trailerStart), prev: Number.isFinite(prev) ? prev : undefined }
}

function objectDictAt(bytes: Uint8Array, offset: number) {
  const header = readInt(bytes, offset)
  if (!header) return undefined
  const gen = readInt(bytes, skipWs(bytes, header.end))
  if (!gen) return undefined
  const body = skipWs(bytes, gen.end)
  if (!matches(bytes, body, "obj")) return undefined
  return readDictAt(bytes, skipWs(bytes, body + 3))
}

function readDictAt(bytes: Uint8Array, at: number): Dict | undefined {
  if (!matches(bytes, at, "<<")) return undefined
  const dict: Dict = new Map()
  let p = skipWs(bytes, at + 2)
  for (let guard = 0; guard < 512 && p < bytes.length; guard++) {
    if (matches(bytes, p, ">>")) break
    if (bytes[p] !== 0x2f) {
      p = skipValue(bytes, p)
      continue
    }
    const nameStart = p
    p += 1
    while (p < bytes.length && !isDelimiter(bytes[p]!) && !isWs(bytes[p]!)) p += 1
    const name = latin1(bytes, nameStart, p)
    p = skipWs(bytes, p)
    const value = readValue(bytes, p)
    if (!value) {
      p += 1
      continue
    }
    dict.set(name, value.value)
    p = skipWs(bytes, value.end)
  }
  return dict
}

function readValue(bytes: Uint8Array, at: number): { value: string | Uint8Array; end: number } | undefined {
  if (at >= bytes.length) return undefined
  if (matches(bytes, at, "<<")) return { value: "", end: dictEnd(bytes, at) }
  if (bytes[at] === 0x5b) return readArray(bytes, at)
  if (bytes[at] === 0x28) {
    const value = literalBytes(bytes, at)
    return value ? { value, end: literalEnd(bytes, at) + 1 } : undefined
  }
  if (bytes[at] === 0x3c) {
    const close = indexOf(bytes, ">", at + 1)
    if (close < 0) return undefined
    return { value: hexBytes(latin1(bytes, at + 1, close).replace(/\s+/g, "")) ?? new Uint8Array(), end: close + 1 }
  }
  if (bytes[at] === 0x2f) {
    const start = at
    let p = at + 1
    while (p < bytes.length && !isDelimiter(bytes[p]!) && !isWs(bytes[p]!)) p += 1
    return { value: latin1(bytes, start, p), end: p }
  }
  const first = readInt(bytes, at)
  if (!first) {
    const start = at
    let p = at
    while (p < bytes.length && !isDelimiter(bytes[p]!) && !isWs(bytes[p]!)) p += 1
    return { value: latin1(bytes, start, p), end: Math.max(p, at + 1) }
  }
  const second = readInt(bytes, skipWs(bytes, first.end))
  if (second) {
    const end = skipWs(bytes, second.end)
    if (matches(bytes, end, "R")) return { value: `${first.value} ${second.value} R`, end: end + 1 }
  }
  return { value: String(first.value), end: first.end }
}

function readArray(bytes: Uint8Array, at: number) {
  let p = at + 1
  let first: string | Uint8Array = ""
  for (let guard = 0; guard < 64 && p < bytes.length; guard++) {
    p = skipWs(bytes, p)
    if (bytes[p] === 0x5d) return { value: first, end: p + 1 }
    const value = readValue(bytes, p)
    if (!value) return { value: first, end: p + 1 }
    if (first === "") first = value.value
    p = value.end
  }
  return { value: first, end: p }
}

function skipValue(bytes: Uint8Array, at: number) {
  const value = readValue(bytes, at)
  return value ? value.end : at + 1
}

function textOf(dict: Dict, key: string) {
  const value = dict.get(key)
  return typeof value === "string" ? value : undefined
}

function bytesOf(dict: Dict, key: string) {
  const value = dict.get(key)
  return value instanceof Uint8Array ? value : undefined
}

function refOf(value: string | Uint8Array | undefined): Ref | undefined {
  if (typeof value !== "string") return undefined
  const match = value.match(/^(\d+)\s+(\d+)\s+R$/)
  return match ? { number: Number(match[1]), gen: Number(match[2]) } : undefined
}

function dictEnd(bytes: Uint8Array, at: number) {
  let depth = 0
  for (let i = at; i < bytes.length - 1; i++) {
    if (bytes[i] === 0x3c && bytes[i + 1] === 0x3c) {
      depth += 1
      i += 1
      continue
    }
    if (bytes[i] === 0x3e && bytes[i + 1] === 0x3e) {
      depth -= 1
      i += 1
      if (depth === 0) return i + 1
    }
  }
  return bytes.length
}

/* ------------------------------------------------------------------ objects */

function decryptObject(bytes: Uint8Array, offset: number, number: number, gen: number, key: Uint8Array, size: number) {
  const header = readInt(bytes, offset)
  if (!header) return
  const generation = readInt(bytes, skipWs(bytes, header.end))
  if (!generation) return
  const body = skipWs(bytes, generation.end)
  if (!matches(bytes, body, "obj")) return
  const start = skipWs(bytes, body + 3)

  const objectKey = objectKeyFor(key, number, gen, size)
  const dict = matches(bytes, start, "<<") ? dictEnd(bytes, start) : start
  decryptStrings(bytes, start, dict, objectKey)

  const streamAt = skipWs(bytes, dict)
  if (!matches(bytes, streamAt, "stream")) return
  let data = streamAt + 6
  if (bytes[data] === 0x0d) data += 1
  if (bytes[data] === 0x0a) data += 1
  const length = streamLength(bytes, start, dict)
  const end = length > 0 ? Math.min(data + length, bytes.length) : Math.max(data, indexOf(bytes, "endstream", data))
  if (end <= data) return
  bytes.set(rc4(objectKey, bytes.subarray(data, end)), data)
}

function streamLength(bytes: Uint8Array, dictStart: number, dictEndAt: number) {
  const text = latin1(bytes, dictStart, dictEndAt)
  const indirect = text.match(/\/Length\s+(\d+)\s+(\d+)\s+R/)
  if (indirect) {
    const at = indexOf(bytes, `${indirect[1]} 0 obj`)
    const value = at >= 0 ? readInt(bytes, skipWs(bytes, at)) : undefined
    return value ? value.value : 0
  }
  const direct = text.match(/\/Length\s+(\d+)/)
  return direct ? Number(direct[1]) : 0
}

/** Decrypts the strings of one object dictionary, in place and without moving a byte. */
function decryptStrings(bytes: Uint8Array, start: number, end: number, key: Uint8Array) {
  for (let i = start; i < end; i++) {
    if (bytes[i] === 0x3c && bytes[i + 1] !== 0x3c) {
      const close = indexOf(bytes, ">", i + 1)
      if (close < 0 || close > end) continue
      const raw = latin1(bytes, i + 1, close)
      // A hex string with whitespace cannot be re-encoded without moving what follows.
      if (/\s/.test(raw) || !/^[0-9A-Fa-f]*$/.test(raw) || raw.length % 2 !== 0) continue
      const plain = rc4(key, hexBytes(raw) ?? new Uint8Array())
      const encoded = Array.from(plain, (byte) => byte.toString(16).padStart(2, "0")).join("")
      writeAscii(bytes, i + 1, encoded)
      i = close
      continue
    }
    if (bytes[i] !== 0x28) continue
    const close = literalEnd(bytes, i)
    if (close < 0 || close > end) continue
    const raw = literalBytes(bytes, i)
    if (!raw) continue
    const plain = rc4(key, raw)
    const safe = plain.every((byte) => byte >= 0x20 && byte <= 0x7e && byte !== 0x28 && byte !== 0x29 && byte !== 0x5c)
    // A literal cannot take an escape without changing its length, and the xref points at bytes.
    writeAscii(bytes, i + 1, safe ? latin1(plain, 0, plain.length) : " ".repeat(plain.length))
    i = close
  }
}

function blankEncrypt(bytes: Uint8Array, start: number, end: number) {
  const text = latin1(bytes, start, end)
  for (const match of text.matchAll(/\/Encrypt\s+\d+\s+\d+\s+R/g)) {
    if (match.index === undefined) continue
    writeAscii(bytes, start + match.index, " ".repeat(match[0].length))
  }
}

/* ------------------------------------------------------------------ security handler */

function fileKey(
  owner: Uint8Array,
  permissions: number,
  id: Uint8Array,
  revision: number,
  size: number,
  encrypt: Dict,
) {
  const padded = PAD.slice()
  const permissionsBytes = new Uint8Array(4)
  new DataView(permissionsBytes.buffer).setInt32(0, permissions, true)
  const metadata = revision >= 4 && textOf(encrypt, "/EncryptMetadata") === "false"
  let hash = md5(concat(padded, owner, permissionsBytes, id, metadata ? new Uint8Array([255, 255, 255, 255]) : new Uint8Array()))
  if (revision >= 3) for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, size))
  return hash.slice(0, size)
}

function authenticates(key: Uint8Array, user: Uint8Array, id: Uint8Array, revision: number) {
  if (revision === 2) return equal(rc4(key, PAD), user.subarray(0, 32))
  let value = rc4(key, md5(concat(PAD, id)))
  for (let i = 1; i <= 19; i++) value = rc4(xorKey(key, i), value)
  return equal(value.subarray(0, 16), user.subarray(0, 16))
}

function objectKeyFor(key: Uint8Array, number: number, gen: number, size: number) {
  const suffix = new Uint8Array([number & 0xff, (number >> 8) & 0xff, (number >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff])
  return md5(concat(key, suffix)).slice(0, Math.min(size + 5, 16))
}

function xorKey(key: Uint8Array, value: number) {
  return key.map((byte) => byte ^ value)
}

/* ------------------------------------------------------------------ bytes */

function latin1(bytes: Uint8Array, start: number, end: number) {
  let out = ""
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]!)
  return out
}

function writeAscii(bytes: Uint8Array, at: number, text: string) {
  for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i) & 0xff
}

function matches(bytes: Uint8Array, at: number, text: string) {
  if (at < 0 || at + text.length > bytes.length) return false
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false
  return true
}

function indexOf(bytes: Uint8Array, text: string, from = 0) {
  const first = text.charCodeAt(0)
  for (let i = Math.max(0, from); i <= bytes.length - text.length; i++) {
    if (bytes[i] !== first) continue
    if (matches(bytes, i, text)) return i
  }
  return -1
}

function lastIndexOf(bytes: Uint8Array, text: string) {
  for (let i = bytes.length - text.length; i >= 0; i--) if (matches(bytes, i, text)) return i
  return -1
}

const isWs = (byte: number) => byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20
const isDelimiter = (byte: number) => byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e || byte === 0x5b || byte === 0x5d || byte === 0x7b || byte === 0x7d || byte === 0x2f || byte === 0x25

function skipWs(bytes: Uint8Array, at: number) {
  let p = at
  while (p < bytes.length && isWs(bytes[p]!)) p += 1
  return p
}

function readInt(bytes: Uint8Array, at: number) {
  let p = at
  let sign = 1
  if (bytes[p] === 0x2d) {
    sign = -1
    p += 1
  }
  const start = p
  let value = 0
  while (p < bytes.length && bytes[p]! >= 0x30 && bytes[p]! <= 0x39) {
    value = value * 10 + (bytes[p]! - 0x30)
    p += 1
  }
  return p > start ? { value: value * sign, end: p } : undefined
}

function hexBytes(hex: string) {
  if (hex.length % 2 !== 0) return undefined
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function literalEnd(bytes: Uint8Array, at: number) {
  let depth = 0
  for (let i = at; i < bytes.length; i++) {
    if (bytes[i] === 0x5c) {
      i += 1
      continue
    }
    if (bytes[i] === 0x28) depth += 1
    if (bytes[i] === 0x29) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function literalBytes(bytes: Uint8Array, at: number) {
  const end = literalEnd(bytes, at)
  if (end < 0) return undefined
  const out: number[] = []
  for (let i = at + 1; i < end; i++) {
    if (bytes[i] !== 0x5c) {
      out.push(bytes[i]!)
      continue
    }
    const next = bytes[++i]!
    if (next >= 0x30 && next <= 0x37) {
      let value = next - 0x30
      for (let k = 0; k < 2 && bytes[i + 1]! >= 0x30 && bytes[i + 1]! <= 0x37; k++) value = value * 8 + (bytes[++i]! - 0x30)
      out.push(value & 0xff)
      continue
    }
    out.push(next === 0x6e ? 0x0a : next === 0x72 ? 0x0d : next === 0x74 ? 0x09 : next === 0x62 ? 0x08 : next === 0x66 ? 0x0c : next)
  }
  return new Uint8Array(out)
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function equal(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function decodeBase64Tail(payload: string) {
  const start = Math.max(0, payload.length - 16384)
  const aligned = start + ((4 - (start % 4)) % 4)
  return atob(payload.slice(aligned))
}

/* ------------------------------------------------------------------ RC4 and MD5 */

function rc4(key: Uint8Array, data: Uint8Array) {
  const state = new Uint8Array(256)
  for (let i = 0; i < 256; i++) state[i] = i
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + state[i]! + key[i % key.length]!) & 0xff
    const swap = state[i]!
    state[i] = state[j]!
    state[j] = swap
  }
  const out = new Uint8Array(data.length)
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 0xff
    j = (j + state[i]!) & 0xff
    const swap = state[i]!
    state[i] = state[j]!
    state[j] = swap
    out[k] = data[k]! ^ state[(state[i]! + state[j]!) & 0xff]!
  }
  return out
}

const MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0)

/** RFC 1321. WebCrypto has no MD5 and the security handler is defined in terms of it. */
function md5(input: Uint8Array) {
  const length = input.length
  const padded = new Uint8Array((((length + 8) >> 6) + 1) * 64)
  padded.set(input)
  padded[length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, (length * 8) >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor((length * 8) / 2 ** 32), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  const words = new Uint32Array(16)
  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(at + i * 4, true)
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      const sum = (a + f + MD5_K[i]! + words[g]!) >>> 0
      const shift = MD5_SHIFTS[(i >> 4) * 4 + (i % 4)]!
      a = d
      d = c
      c = b
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0
    }
    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }

  const out = new Uint8Array(16)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, a0, true)
  outView.setUint32(4, b0, true)
  outView.setUint32(8, c0, true)
  outView.setUint32(12, d0, true)
  return out
}
