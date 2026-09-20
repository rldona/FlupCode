/**
 * The copyable commands behind "Local network (without relay)" (TN-1).
 *
 * Pure builders, so the port, the CORS origin and the tunnel target can be tested without a
 * browser: a command with the wrong port is the whole feature failing silently.
 */

export const DEFAULT_ENGINE_PORT = 4096

/** The port of an engine URL, or the default when it names none. */
export function enginePort(baseUrl: string): number {
  try {
    const port = new URL(baseUrl).port
    const parsed = Number.parseInt(port, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ENGINE_PORT
  } catch {
    return DEFAULT_ENGINE_PORT
  }
}

/** Serve this machine on the LAN, allowing the page that shows the command. */
export function lanServeCommand(port: number, origin: string): string {
  return `OPENCODE_SERVER_PASSWORD=… opencode serve --hostname 0.0.0.0 --port ${port} --cors ${origin}`
}

/** Expose the local engine through a Cloudflare tunnel. */
export function tunnelCommand(port: number): string {
  return `cloudflared tunnel --url http://localhost:${port}`
}
