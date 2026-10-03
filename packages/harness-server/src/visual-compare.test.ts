import { describe, expect, test } from "bun:test"
import { deflateSync } from "node:zlib"
import { PNG } from "./browser-preview.fixture"
import { decodePng, encodePng, type Image } from "./png"
import { PIXEL_THRESHOLD, compareImages } from "./visual-compare"

/**
 * A visual check's comparison (CL-4): the PNG it reads captures with, and what counts as a change.
 */

const solid = (width: number, height: number, colour: [number, number, number]): Image => {
  const data = new Uint8Array(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel++) data.set([...colour, 255], pixel * 4)
  return { width, height, data }
}

const paint = (image: Image, box: { x: number; y: number; width: number; height: number }, colour: [number, number, number]) => {
  const data = new Uint8Array(image.data)
  for (let y = box.y; y < box.y + box.height; y++)
    for (let x = box.x; x < box.x + box.width; x++) data.set([...colour, 255], (y * image.width + x) * 4)
  return { ...image, data }
}

/** A PNG chunk; the reader does not check the CRC, so it is left at zero. */
const chunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, "latin1")
  return Buffer.concat([head, data, Buffer.alloc(4)])
}

describe("the PNG a capture is read with", () => {
  test("an RGBA image survives a write and a read", () => {
    const image = paint(solid(7, 5, [255, 255, 255]), { x: 2, y: 1, width: 3, height: 2 }, [10, 120, 200])
    const read = decodePng(encodePng(image))
    expect(read.width).toBe(7)
    expect(read.height).toBe(5)
    expect([...read.data]).toEqual([...image.data])
  })

  test("an RGB image with every row filter (none aside) reads back to its pixels", () => {
    // Two pixels a row, filtered by hand: Sub, Up, Average, Paeth (PNG §9.2).
    const rows = [
      [1, 10, 20, 30, 5, 5, 5],
      [2, 10, 10, 10, 15, 15, 15],
      [3, 30, 35, 40, 15, 15, 15],
      [4, 5, 5, 5, 10, 10, 10],
    ]
    const header = Buffer.alloc(13)
    header.writeUInt32BE(2, 0)
    header.writeUInt32BE(4, 4)
    header[8] = 8
    header[9] = 2
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.from(rows.flat()))),
      chunk("IEND", Buffer.alloc(0)),
    ])
    const read = decodePng(png)
    const pixels = Array.from({ length: 8 }, (_, pixel) => [...read.data.subarray(pixel * 4, pixel * 4 + 4)])
    expect(pixels).toEqual([
      [10, 20, 30, 255],
      [15, 25, 35, 255],
      [20, 30, 40, 255],
      [30, 40, 50, 255],
      [40, 50, 60, 255],
      [50, 60, 70, 255],
      [45, 55, 65, 255],
      [60, 70, 80, 255],
    ])
  })

  test("the preview's own capture reads, and what is not a PNG it can read is refused", () => {
    expect(decodePng(PNG)).toMatchObject({ width: 1, height: 1 })
    expect(() => decodePng(Buffer.from("not a picture"))).toThrow("Not a PNG")
    const header = Buffer.alloc(13)
    header.writeUInt32BE(1, 0)
    header.writeUInt32BE(1, 4)
    header[8] = 16
    header[9] = 2
    const deep = Buffer.concat([PNG.subarray(0, 8), chunk("IHDR", header), chunk("IEND", Buffer.alloc(0))])
    expect(() => decodePng(deep)).toThrow("A PNG this cannot read")
  })
})

describe("comparing two captures of a step (CL-4)", () => {
  const white = solid(100, 50, [255, 255, 255])

  test("the same picture has nothing changed; a block that moved is its share of the page", () => {
    expect(compareImages(white, white).changed).toBe(0)
    const marked = paint(white, { x: 10, y: 10, width: 10, height: 5 }, [200, 0, 0])
    const result = compareImages(white, marked)
    expect(result.differing).toBe(50)
    expect(result.changed).toBeCloseTo(50 / 5000)
    expect(result.sameSize).toBe(true)
    // The difference marks the changed pixels and washes out the rest.
    const at = (x: number, y: number) => [...result.diff.data.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 4)]
    expect(at(12, 12)).toEqual([230, 40, 60, 255])
    expect(at(50, 40)).toEqual([255, 255, 255, 255])
  })

  test("a shift below the threshold, as antialiasing and colour rounding leave, is not a change", () => {
    const shade = 255 - PIXEL_THRESHOLD
    expect(compareImages(white, solid(100, 50, [shade, shade, shade])).changed).toBe(0)
    expect(compareImages(white, solid(100, 50, [shade - 1, shade, shade])).changed).toBe(1)
  })

  test("a masked region is not compared, and is not counted in the share", () => {
    const ticking = paint(white, { x: 80, y: 0, width: 20, height: 10 }, [0, 0, 0])
    const masks = [{ x: 79.5, y: 0, width: 21, height: 10.2 }]
    const result = compareImages(white, ticking, { masks })
    expect(result.changed).toBe(0)
    expect(result.compared).toBe(5000 - 21 * 11)
    expect([...result.diff.data.subarray((5 * 100 + 90) * 4, (5 * 100 + 90) * 4 + 4)]).toEqual([150, 150, 150, 255])
    // Outside the mask a change still counts.
    expect(compareImages(white, paint(ticking, { x: 0, y: 0, width: 1, height: 1 }, [0, 0, 0]), { masks }).differing).toBe(1)
  })

  test("captures of different sizes are not comparable: everything changed", () => {
    const result = compareImages(white, solid(100, 60, [255, 255, 255]))
    expect(result).toMatchObject({ changed: 1, sameSize: false })
    expect(result.diff.height).toBe(60)
  })
})
