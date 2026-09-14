import { createSignal } from "solid-js"

/**
 * The integrated browser panel. Links to a local preview in the transcript ask it to navigate from
 * anywhere, so the panel does not need to be reached through a prop chain.
 */
export type BrowserRequest = { url: string; nonce: number }

let nonce = 0
const [request, setRequest] = createSignal<BrowserRequest>()

export const browser = {
  request,
  open(url: string) {
    setRequest({ url, nonce: ++nonce })
  },
}

/** Dev servers and LAN previews embed in the panel; anything else is safer in a real tab. */
export function isLocalPreview(url: string) {
  const host = hostname(url)
  if (!host) return false
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host === "::1" || host === "[::1]" || host === "0.0.0.0") return true
  if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.")) return true
  return /^172\.(1[6-9]|2\d|3[01])\./.test(host)
}

function hostname(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}
