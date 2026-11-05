import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const ICONS = join(import.meta.dir, "../build/icons")
const SIZES = [16, 22, 24, 32, 48, 64, 96, 128, 256, 512]

const pngSize = (path: string) => {
  const bytes = readFileSync(path)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

describe("the Linux hicolor icon set", () => {
  test("ships every size the theme looks for", () => {
    const files = readdirSync(ICONS)
    for (const size of SIZES) expect(files).toContain(`${size}x${size}.png`)
  })

  test("each file declares its own size in the PNG header", () => {
    for (const size of SIZES) expect(pngSize(join(ICONS, `${size}x${size}.png`))).toEqual({ width: size, height: size })
  })

  test("no icon is larger than the biggest size hicolor declares", () => {
    const pngs = readdirSync(ICONS).filter((file) => file.endsWith(".png"))
    for (const file of pngs) {
      const { width, height } = pngSize(join(ICONS, file))
      expect(width).toBeLessThanOrEqual(512)
      expect(height).toBeLessThanOrEqual(512)
    }
  })
})
