import { deflateSync, inflateSync } from "node:zlib"

/**
 * Just enough PNG to compare two captures of a page (CL-4): 8-bit, non-interlaced grey, grey and
 * alpha, RGB and RGBA in, RGBA out. That is what Chromium and Electron's `capturePage` write. Anything
 * else (a palette, 16-bit, interlaced) is refused rather than misread.
 */

export type Image = { width: number; height: number; data: Uint8Array }

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Channels per pixel, by PNG colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }

export function decodePng(bytes: Uint8Array): Image {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("Not a PNG")
  const chunks = readChunks(buffer)
  const header = chunks.find((chunk) => chunk.type === "IHDR")?.data
  if (!header) throw new Error("A PNG without a header")
  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  const depth = header[8]!
  const colour = header[9]!
  const interlaced = header[12]!
  const channels = CHANNELS[colour]
  if (depth !== 8 || channels === undefined || interlaced !== 0)
    throw new Error(`A PNG this cannot read (depth ${depth}, colour type ${colour}, interlace ${interlaced})`)
  const packed = inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data)))
  const stride = width * channels
  if (packed.length < (stride + 1) * height) throw new Error("A PNG with less data than its size")
  const raw = new Uint8Array(stride * height)
  // Loops rather than array methods here and below: a retina capture is millions of pixels.
  for (let row = 0; row < height; row++) unfilter(packed, raw, row, stride, channels)
  const data = new Uint8Array(width * height * 4)
  const grey = channels < 3
  for (let pixel = 0; pixel < width * height; pixel++) {
    const from = pixel * channels
    const to = pixel * 4
    data[to] = raw[from]!
    data[to + 1] = grey ? raw[from]! : raw[from + 1]!
    data[to + 2] = grey ? raw[from]! : raw[from + 2]!
    data[to + 3] = channels === 4 ? raw[from + 3]! : channels === 2 ? raw[from + 1]! : 255
  }
  return { width, height, data }
}

/** An RGBA image as a PNG, every row unfiltered: small enough for a difference picture. */
export function encodePng(image: Image) {
  const stride = image.width * 4
  const packed = Buffer.alloc((stride + 1) * image.height)
  for (let row = 0; row < image.height; row++)
    packed.set(image.data.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(packed)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

function readChunks(buffer: Buffer) {
  const chunks: Array<{ type: string; data: Buffer }> = []
  const cursor = { at: 8 }
  while (cursor.at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(cursor.at)
    const type = buffer.toString("latin1", cursor.at + 4, cursor.at + 8)
    chunks.push({ type, data: buffer.subarray(cursor.at + 8, cursor.at + 8 + length) })
    cursor.at += 12 + length
    if (type === "IEND") break
  }
  return chunks
}

/** Undoes one row's filter in place, from the row above it (PNG §9). */
function unfilter(packed: Buffer, raw: Uint8Array, row: number, stride: number, bpp: number) {
  const filter = packed[row * (stride + 1)]!
  const line = packed.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1))
  const out = row * stride
  if (filter > 4) throw new Error(`A PNG row with an unknown filter ${filter}`)
  for (let index = 0; index < stride; index++) {
    const left = index >= bpp ? raw[out + index - bpp]! : 0
    const up = row > 0 ? raw[out - stride + index]! : 0
    const corner = row > 0 && index >= bpp ? raw[out - stride + index - bpp]! : 0
    const predicted =
      filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, corner)
    raw[out + index] = (line[index]! + predicted) & 0xff
  }
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, "latin1")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) =>
  Array.from({ length: 8 }).reduce<number>((c) => (c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1), n),
)

function crc32(bytes: Uint8Array) {
  return (bytes.reduce((crc, byte) => CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0
}
