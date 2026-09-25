/**
 * Where a browser a person started may go (WA-1).
 *
 * The browser is the one part of the harness that follows links somebody else wrote, so it is the
 * part that can be pointed at a cloud metadata endpoint or a machine on the local network. This
 * refuses those destinations before a navigation begins; it is pure policy and never touches
 * Playwright, so it can be tested without a browser.
 */

import { lookup } from "node:dns/promises"
import { isIPv4, isIPv6 } from "node:net"

export class NavigationBlockedError extends Error {
  readonly code = "navigation_blocked"

  constructor(
    readonly reason: string,
    readonly url?: string,
  ) {
    super(reason)
    this.name = "NavigationBlockedError"
  }
}

export type EgressGuard = { assertNavigable(url: string): Promise<URL> }

export function isBlockedAddress(ip: string): boolean {
  if (isIPv4(ip)) return isBlockedIPv4(ip)
  if (isIPv6(ip)) return isBlockedIPv6(ip)
  return true
}

/**
 * `allowLoopbackPorts` exists only so tests can point the guard at a local fixture server.
 * Production never passes it; a loopback destination without a matching allowed port is refused.
 */
export function createEgressGuard(options?: { allowLoopbackPorts?: number[] }): EgressGuard {
  const allowedPorts = new Set(options?.allowLoopbackPorts ?? [])
  return {
    async assertNavigable(input: string): Promise<URL> {
      if (!URL.canParse(input)) throw new NavigationBlockedError("Not a valid URL", input)
      const url = new URL(input)
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new NavigationBlockedError(`Scheme ${url.protocol} is not allowed`, input)
      if (url.username !== "" || url.password !== "")
        throw new NavigationBlockedError("URLs with credentials are not allowed", input)

      const host = url.hostname.replace(/^\[|\]$/g, "")
      const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port)
      if (loopbackAllowed(host, port, allowedPorts)) return url
      if (isIPv4(host) || isIPv6(host)) {
        if (isBlockedAddress(host)) throw new NavigationBlockedError("That address is not allowed", input)
        return url
      }

      const addresses = await lookup(host, { all: true }).then(
        (entries) => entries,
        () => undefined,
      )
      // Fail-closed: a name the resolver cannot answer for is not one this guard can vouch for.
      if (!addresses || addresses.length === 0)
        throw new NavigationBlockedError("That host could not be resolved", input)
      if (addresses.some((entry) => isBlockedAddress(entry.address)))
        throw new NavigationBlockedError("That host resolves to an address that is not allowed", input)
      return url
    },
  }
}

function loopbackAllowed(host: string, port: number, allowedPorts: Set<number>): boolean {
  if (!allowedPorts.has(port)) return false
  return host === "localhost" || host === "::1" || (isIPv4(host) && host.startsWith("127."))
}

function isBlockedIPv4(ip: string): boolean {
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number)
  if (a === 0) return true
  if (a === 10) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && c === 0) return true
  if (a === 192 && b === 0 && c === 2) return true
  if (a === 192 && b === 88 && c === 99) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  if (a >= 224) return true
  return false
}

function isBlockedIPv6(ip: string): boolean {
  const bytes = ipv6Bytes(ip)
  if (!bytes) return true
  const at = (index: number) => bytes[index] ?? 0
  const mapped = [at(12), at(13), at(14), at(15)].join(".")
  if (isZero(bytes.subarray(0, 10)) && at(10) === 0xff && at(11) === 0xff) return isBlockedIPv4(mapped)
  if (at(0) === 0x00 && at(1) === 0x64 && at(2) === 0xff && at(3) === 0x9b && isZero(bytes.subarray(4, 12)))
    return isBlockedIPv4(mapped)
  // `::/96` with a real IPv4 in the tail: an IPv4-compatible address the mapped check above skips.
  if (isZero(bytes.subarray(0, 12))) return isBlockedIPv4(mapped)
  // 6to4 `2002::/16` carries the IPv4 across bytes 2..5, not the tail.
  if (at(0) === 0x20 && at(1) === 0x02) return isBlockedIPv4([at(2), at(3), at(4), at(5)].join("."))
  // IPv4-translated `::ffff:0:0/96`, whose IPv4 is still in the tail but under another prefix.
  if (isZero(bytes.subarray(0, 8)) && at(8) === 0xff && at(9) === 0xff) return isBlockedIPv4(mapped)
  // NAT64 local-use `64:ff9b:1::/48`.
  if (
    at(0) === 0x00 &&
    at(1) === 0x64 &&
    at(2) === 0xff &&
    at(3) === 0x9b &&
    at(4) === 0x00 &&
    at(5) === 0x01
  )
    return isBlockedIPv4(mapped)
  if (isZero(bytes)) return true
  if (isZero(bytes.subarray(0, 15)) && at(15) === 1) return true
  if ((at(0) & 0xfe) === 0xfc) return true
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0x80) return true
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0xc0) return true
  if (at(0) === 0xff) return true
  if (at(0) === 0x20 && at(1) === 0x01 && at(2) === 0x0d && at(3) === 0xb8) return true
  return false
}

function ipv6Bytes(ip: string): Uint8Array | undefined {
  const zone = ip.indexOf("%")
  const address = zone === -1 ? ip : ip.slice(0, zone)
  const separator = address.indexOf("::")
  if (separator !== -1 && address.indexOf("::", separator + 2) !== -1) return undefined
  const parts = address.split("::")
  const headGroups = parseGroups(parts[0] ?? "")
  const tailGroups = parseGroups(parts[1] ?? "")
  if (!headGroups || !tailGroups) return undefined
  const missing = 8 - headGroups.length - tailGroups.length
  if (separator === -1 ? missing !== 0 : missing < 1) return undefined
  const groups = separator === -1 ? headGroups : [...headGroups, ...Array<number>(missing).fill(0), ...tailGroups]
  return Uint8Array.from(groups.flatMap((group) => [(group >> 8) & 0xff, group & 0xff]))
}

function parseGroups(text: string): number[] | undefined {
  if (text === "") return []
  return text.split(":").reduce<number[] | undefined>((groups, group, index, all) => {
    if (!groups) return undefined
    if (group.includes(".")) {
      if (index !== all.length - 1 || !isIPv4(group)) return undefined
      const [o0 = 0, o1 = 0, o2 = 0, o3 = 0] = group.split(".").map(Number)
      return [...groups, (o0 << 8) | o1, (o2 << 8) | o3]
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined
    return [...groups, parseInt(group, 16)]
  }, [])
}

function isZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0)
}
