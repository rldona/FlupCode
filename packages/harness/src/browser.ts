import { createSignal } from "solid-js"

/**
 * The integrated browser panel. Links in the transcript ask it to navigate from anywhere, so the
 * panel does not need to be reached through a prop chain.
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

/**
 * Whether the panel can navigate to a URL: only an absolute http(s) URL. Anything else — another
 * scheme, a relative path, an anchor or a malformed string — has no page the panel can embed.
 */
export function isBrowsableUrl(url: string): boolean {
  if (!URL.canParse(url)) return false
  const protocol = new URL(url).protocol
  return protocol === "http:" || protocol === "https:"
}
