export type Bytes = Uint8Array<ArrayBuffer>

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function utf8(text: string): Bytes {
  return encoder.encode(text) as Bytes
}

export function text(bytes: Uint8Array) {
  return decoder.decode(bytes)
}

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0))
  parts.reduce((offset, part) => {
    out.set(part, offset)
    return offset + part.byteLength
  }, 0)
  return out
}

export function random(size: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(size))
}

export function toBase64Url(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}

export function fromBase64Url(value: string): Bytes {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export function equal(a: Uint8Array, b: Uint8Array) {
  if (a.byteLength !== b.byteLength) return false
  return a.reduce((diff, byte, index) => diff | (byte ^ b[index]!), 0) === 0
}

/** Normalises any binary WebSocket payload into bytes. */
export async function asBytes(data: ArrayBuffer | ArrayBufferView | Blob): Promise<Bytes> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
  return new Uint8Array(await data.arrayBuffer())
}
