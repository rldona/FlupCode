import { STORAGE_KEYS, readStorage, writeStorage } from "./storage"

/**
 * Whether a link has a page a browser can open: only an absolute http(s) URL. Anything else —
 * another scheme, a relative path, an anchor or a malformed string — is left to the OS.
 */
export function isBrowsableUrl(url: string): boolean {
  if (!URL.canParse(url)) return false
  const protocol = new URL(url).protocol
  return protocol === "http:" || protocol === "https:"
}

/**
 * The origin a link points at, which is what the "don't ask again" memory keys on. The origin and
 * not the bare hostname: `http` and `https`, or two ports, are different destinations, and the
 * memory must not let a downgrade or another port ride on a host the reader already trusted.
 */
export function externalLinkOrigin(url: string): string | undefined {
  // Only http(s) has a real origin; a `mailto:` or a relative path parses but its origin is the
  // string "null", which must never become a remembered destination.
  if (!isBrowsableUrl(url)) return undefined
  return new URL(url).origin
}

/** Remember that the reader never wants to be asked about this origin again. */
export function rememberExternalLinkOrigin(origin: string): void {
  const origins = readStorage<string[]>(STORAGE_KEYS.externalLinkHosts, [])
  if (origins.includes(origin)) return
  writeStorage(STORAGE_KEYS.externalLinkHosts, [...origins, origin])
}

/** Whether this origin is one the reader already chose to open without asking. */
export function isExternalLinkAllowed(url: string): boolean {
  const origin = externalLinkOrigin(url)
  if (!origin) return false
  return readStorage<string[]>(STORAGE_KEYS.externalLinkHosts, []).includes(origin)
}

/**
 * Open a link outside the app: the system browser in the desktop build, a new tab in the web one.
 * Only an http(s) URL is ever opened here — a caller that forgot to check fails closed — and the
 * desktop bridge refuses anything else on its own side too.
 */
export function openExternalUrl(url: string): void {
  if (!isBrowsableUrl(url)) return
  const bridge = typeof window !== "undefined" ? window.flupcode?.openExternal : undefined
  if (bridge) {
    void bridge(url)
    return
  }
  window.open(url, "_blank", "noopener,noreferrer")
}
