import { fromBase64Url, text, toBase64Url, utf8 } from "./bytes"

/** Pairing links carried in a QR code. The data lives in the URL fragment, never sent to a server. */

export const PAIRING_TTL = 10 * 60 * 1000
const PARAM = "remote"

export type PairingLink = {
  v: 1
  /** Relay WebSocket base URL, e.g. `wss://relay.flupcode.com`. */
  relay: string
  /** Relay host id. */
  host: string
  /** Pairing id. */
  id: string
  /** Base64url pairing secret. */
  secret: string
  /** Human-readable host name. */
  name: string
}

export function pairingUrl(appUrl: string, link: PairingLink) {
  const url = new URL(appUrl)
  url.hash = `${PARAM}=${toBase64Url(utf8(JSON.stringify(link)))}`
  return url.toString()
}

export function parsePairingHash(hash: string): PairingLink | undefined {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get(PARAM)
  if (!value) return undefined
  try {
    const link = JSON.parse(text(fromBase64Url(value))) as Partial<PairingLink>
    if (link.v !== 1) return undefined
    if (![link.relay, link.host, link.id, link.secret, link.name].every((part) => typeof part === "string")) return undefined
    if (!/^wss?:\/\//.test(link.relay!)) return undefined
    return link as PairingLink
  } catch {
    return undefined
  }
}
