import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "electron"

type Bounds = {
  width: number
  height: number
  x?: number
  y?: number
}

const DEFAULT_BOUNDS: Bounds = { width: 1280, height: 840 }

function stateFile() {
  return join(app.getPath("userData"), "window-state.json")
}

export function loadBounds(): Bounds {
  try {
    if (!existsSync(stateFile())) return DEFAULT_BOUNDS
    const raw = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<Bounds>
    return {
      width: typeof raw.width === "number" ? raw.width : DEFAULT_BOUNDS.width,
      height: typeof raw.height === "number" ? raw.height : DEFAULT_BOUNDS.height,
      x: typeof raw.x === "number" ? raw.x : undefined,
      y: typeof raw.y === "number" ? raw.y : undefined,
    }
  } catch {
    return DEFAULT_BOUNDS
  }
}

export function saveBounds(bounds: Bounds) {
  try {
    writeFileSync(stateFile(), JSON.stringify(bounds))
  } catch {
    return
  }
}
