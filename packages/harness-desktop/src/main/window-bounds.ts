/**
 * Where a window opens, and where the next one goes (H-36).
 *
 * Kept apart from the file and from Electron so it can be tested: the rule is small but it is the
 * difference between a second window appearing on top of the first and appearing beside it.
 */

export type WindowBounds = {
  width: number
  height: number
  x?: number
  y?: number
}

export const DEFAULT_BOUNDS: WindowBounds = { width: 1280, height: 840 }

/** How far each new window steps down and across from the one before it. */
export const CASCADE_STEP = 28

/** Its remembered spot, or the one before it stepped down, so windows do not stack exactly. */
export function cascade(bounds: WindowBounds, index: number): WindowBounds {
  if (index <= 0) return bounds
  return { ...bounds, x: (bounds.x ?? 0) + CASCADE_STEP * index, y: (bounds.y ?? 0) + CASCADE_STEP * index }
}

export function decodeBounds(value: unknown): WindowBounds | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Partial<WindowBounds>
  if (typeof raw.width !== "number" || typeof raw.height !== "number") return undefined
  return {
    width: raw.width,
    height: raw.height,
    ...(typeof raw.x === "number" ? { x: raw.x } : {}),
    ...(typeof raw.y === "number" ? { y: raw.y } : {}),
  }
}

/** Reads what the app wrote: one window's bounds in the old file, a list of them now. */
export function decodeWindowStates(value: unknown): WindowBounds[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const bounds = decodeBounds(entry)
      return bounds ? [bounds] : []
    })
  }
  const single = decodeBounds(value)
  return single ? [single] : []
}
