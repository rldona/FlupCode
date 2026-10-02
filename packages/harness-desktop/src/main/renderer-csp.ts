/**
 * The Content-Security-Policy the packaged renderer (`oc://renderer`) is served under (TI-17).
 *
 * The same policy as the hosted app (harness/vercel.json) except in two directives. `connect-src`:
 * the hosted app may talk to an engine anywhere, while this window only ever talks to the engine and
 * harness server this app started on loopback, and to the remote control relay, so a compromised
 * page has no origin of its own choosing to send what it reads to. `script-src` adds
 * `'wasm-unsafe-eval'`: the markdown worker's highlighter compiles a WebAssembly regex engine, which
 * `'self'` alone refuses, and the transcript would fall back to raw text.
 */
export function rendererCsp(relay: string) {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${["'self'", ...LOOPBACK, ...relaySources(relay)].join(" ")}`,
    "frame-src http: https:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ")
}

// Any port: the engine proxy, the harness server and the engine itself each pick one.
const LOOPBACK = ["http://127.0.0.1:*", "ws://127.0.0.1:*", "http://localhost:*", "ws://localhost:*"]

// The relay is a WebSocket, but its notification key is fetched over plain HTTP(S) (harness/src/push.ts).
function relaySources(relay: string) {
  if (!URL.canParse(relay)) return []
  const url = new URL(relay)
  if (url.protocol === "wss:" || url.protocol === "https:") return [`wss://${url.host}`, `https://${url.host}`]
  if (url.protocol === "ws:" || url.protocol === "http:") return [`ws://${url.host}`, `http://${url.host}`]
  return []
}
