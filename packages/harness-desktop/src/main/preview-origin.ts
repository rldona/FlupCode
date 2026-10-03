/**
 * Where the preview may go on its own (BU-06).
 *
 * The preview is for the project's dev server, so a page on this machine (loopback) opens without a
 * question. Any other web origin only opens once the harness server's browser policy allowed it
 * (BU-01): main keeps the origins it was told about and refuses the rest, so a page that links or
 * redirects away cannot take the preview with it. Anything that is not a web address never opens.
 *
 * Pure, and the same rule as `isLoopbackUrl` in harness-server's `browser-preview.ts`: the two
 * processes share no code, and both have to agree on what loopback is.
 */

export type PreviewVerdict = "allow" | "ask" | "refuse"

export function previewVerdict(value: string, allowed: ReadonlySet<string> = new Set()): PreviewVerdict {
  if (value === "about:blank") return "allow"
  if (!URL.canParse(value)) return "refuse"
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") return "refuse"
  if (url.username !== "" || url.password !== "") return "refuse"
  if (isLoopbackHost(url.hostname)) return "allow"
  return allowed.has(url.origin) ? "allow" : "ask"
}

/** `localhost` and its subdomains, `127.0.0.0/8` and `::1`: this machine and nothing else. */
export function isLoopbackHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true
  const octets = host.split(".")
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  )
}

/** The address bar's text as an address: a bare `localhost:5173` or `:3000` means http on this machine. */
export function addressOf(text: string) {
  const value = text.trim()
  if (/^:\d{1,5}(\/.*)?$/.test(value)) return `http://localhost${value}`
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value === "about:blank") return value
  return `http://${value}`
}
