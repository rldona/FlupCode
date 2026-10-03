import type { Image } from "./png"

/**
 * Two captures of the same step, compared pixel by pixel (CL-4).
 *
 * A pixel differs when one of its channels moved by more than `threshold` (0–255), so antialiasing
 * and colour rounding between two renders of the same page are not a change. Masked regions (a
 * clock, a timestamp, an avatar) are not compared at all. `changed` is the share of the compared
 * pixels that differ; whether that is "the same page" is the caller's tolerance, not this.
 *
 * Two captures of different sizes are not comparable: the window or the page's height changed, and
 * that is reported as everything changed rather than as a guess at alignment.
 */
export function compareImages(before: Image, after: Image, options: { masks?: Region[]; threshold?: number } = {}) {
  const threshold = options.threshold ?? PIXEL_THRESHOLD
  const masks = options.masks ?? []
  const data = new Uint8Array(after.width * after.height * 4)
  if (before.width !== after.width || before.height !== after.height) {
    data.set(after.data)
    return { changed: 1, differing: after.width * after.height, compared: after.width * after.height, sameSize: false, diff: { width: after.width, height: after.height, data } }
  }
  const masked = maskOf(after.width, after.height, masks)
  const counts = { differing: 0, compared: 0 }
  // A loop rather than array methods: a retina capture is millions of pixels.
  for (let pixel = 0; pixel < after.width * after.height; pixel++) {
    const at = pixel * 4
    if (masked[pixel]) {
      data.set(MASKED, at)
      continue
    }
    counts.compared++
    const delta = Math.max(
      Math.abs(before.data[at]! - after.data[at]!),
      Math.abs(before.data[at + 1]! - after.data[at + 1]!),
      Math.abs(before.data[at + 2]! - after.data[at + 2]!),
      Math.abs(before.data[at + 3]! - after.data[at + 3]!),
    )
    if (delta > threshold) {
      counts.differing++
      data.set(DIFFERS, at)
      continue
    }
    // The page itself, washed out, so the marks read against where they are.
    const light = 255 - ((255 - (after.data[at]! * 0.3 + after.data[at + 1]! * 0.59 + after.data[at + 2]! * 0.11)) >> 2)
    data.set([light, light, light, 255], at)
  }
  return {
    changed: counts.compared === 0 ? 0 : counts.differing / counts.compared,
    differing: counts.differing,
    compared: counts.compared,
    sameSize: true,
    diff: { width: after.width, height: after.height, data },
  }
}

/** A rectangle of the capture, in its own pixels. */
export type Region = { x: number; y: number; width: number; height: number }

/** How far a channel may move before the pixel counts as changed. */
export const PIXEL_THRESHOLD = 32

const DIFFERS = [230, 40, 60, 255]
const MASKED = [150, 150, 150, 255]

function maskOf(width: number, height: number, regions: Region[]) {
  const masked = new Uint8Array(width * height)
  regions.forEach((region) => {
    const left = Math.max(0, Math.floor(region.x))
    const top = Math.max(0, Math.floor(region.y))
    const right = Math.min(width, Math.ceil(region.x + region.width))
    const bottom = Math.min(height, Math.ceil(region.y + region.height))
    for (let row = top; row < bottom; row++) masked.fill(1, row * width + left, row * width + Math.max(left, right))
  })
  return masked
}
