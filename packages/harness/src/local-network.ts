/**
 * Chrome's Local Network Access (H-45).
 *
 * A public page reaching an engine on the machine is a local network request, and Chrome 141+ gates
 * those behind a permission the user grants once per site. The prompt only appears while a connection
 * to a local destination is being made, and it has to succeed for the prompt to appear at all
 * (WICG/local-network-access#44) — so the ask is a request to the engine itself, made from a click.
 * `navigator.permissions.request()` does not exist for it; only querying does.
 *
 * Nothing is annotated until the permission is granted: `targetAddressSpace` is what declares the
 * target space and moves the call behind the gate, and sending it uninvited is what took the hosted
 * app off its engine once (#91, reverted in #92).
 */

export type AddressSpace = "loopback" | "local" | "public"

/**
 * What the browser says about the permission.
 *
 * `unsupported` is not a failure: a browser that knows none of the names is not one that gates
 * anything, and the app then behaves exactly as it did before this existed.
 */
export type LocalNetworkState = "granted" | "prompt" | "denied" | "unsupported"

const LOOPBACK_HOSTS = new Set(["localhost", "::1", "[::1]"])
const PRIVATE_IPV4 = [
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
]
const PRIVATE_IPV6 = [/^\[?(fc|fd|fe80)/i]

/**
 * Where an address is, as far as its name can say.
 *
 * A public hostname that resolves to a local address is "public" here: the string cannot tell, and
 * that case is exactly what `targetAddressSpace` is for when the space is known some other way.
 * Anything that is not a web address — the desktop app's `oc://` — has no space at all.
 */
export function addressSpaceOf(url: string): AddressSpace | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return undefined
  }
  const host = parsed.hostname.toLowerCase()
  if (LOOPBACK_HOSTS.has(host) || host.startsWith("127.")) return "loopback"
  if (host.endsWith(".local") || PRIVATE_IPV4.some((pattern) => pattern.test(host)) || PRIVATE_IPV6.some((pattern) => pattern.test(host))) {
    return "local"
  }
  return "public"
}

/**
 * Whether a request from this page to this engine is gated, in the spec's own terms: a public page
 * reaching either local space, and a local page reaching loopback. Loopback to loopback is the same
 * space, which is why the desktop app and a dev server never see a prompt.
 */
export function localNetworkGated(page: AddressSpace | undefined, engine: AddressSpace | undefined): boolean {
  if (!page || !engine || engine === "public") return false
  if (page === "public") return true
  return page === "local" && engine === "loopback"
}

/**
 * The names to ask about, granular first and the alias after it.
 *
 * Chrome 145 split the permission into `loopback-network` and `local-network`, and kept
 * `local-network-access` as an alias of both. Asking for the name rather than choosing by version:
 * whichever is known answers, and one that is not known rejects.
 */
export function localNetworkPermissions(engine: AddressSpace): string[] {
  return engine === "loopback" ? ["loopback-network", "local-network-access"] : ["local-network", "local-network-access"]
}

/**
 * What the browser knows, from the first name it understands.
 *
 * A fake `query` is accepted so the fallback chain can be tested without a browser that has the
 * permission at all.
 */
export async function queryLocalNetworkPermission(
  names: string[],
  query: (name: string) => Promise<{ state: PermissionState }> = (name) =>
    navigator.permissions.query({ name: name as PermissionName }),
): Promise<LocalNetworkState> {
  for (const name of names) {
    try {
      return (await query(name)).state
    } catch {
      // This browser does not know that name; try the next.
    }
  }
  return "unsupported"
}
