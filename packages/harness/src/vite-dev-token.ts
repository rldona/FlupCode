import { existsSync, readFileSync } from "node:fs"
import type { IncomingMessage } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "vite"

/**
 * Dev only (AH-A05): hands a plain `vite` tab the harness bearer the desktop would, so the runs,
 * artifacts and event stream answer while developing without the desktop app.
 *
 * `apply` keeps it out of `vite build` and `vite preview`, so no token reaches `dist/`. The
 * token is not written into the HTML: the dev server listens on `0.0.0.0` and answers other localhost
 * origins, so the page only names a script, and that script carries the token only for a same-origin
 * request from the loopback. A cross-site `<script src>` or a LAN peer gets an empty file.
 */

export const DEV_TOKEN_PATH = "/@flupcode/dev-token.js"

export function devTokenPlugin(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): Plugin {
  return {
    name: "flupcode-dev-token",
    // `vite preview` also resolves as "serve"; it is excluded by name so the plugin never sees `dist/`.
    apply: (_config, context) => context.command === "serve" && !context.isPreview,
    transformIndexHtml: () => [{ tag: "script", attrs: { src: DEV_TOKEN_PATH }, injectTo: "head-prepend" }],
    configureServer: (server) => {
      server.middlewares.use(DEV_TOKEN_PATH, (request, response) => {
        const token = trustedRequest(request) ? readDevToken(env, home) : undefined
        response.setHeader("content-type", "text/javascript")
        response.setHeader("cache-control", "no-store")
        response.end(devTokenScript(token))
      })
    },
  }
}

/** Never overrides the desktop: its preload already defines `window.flupcode` with the token. */
export function devTokenScript(token: string | undefined) {
  if (!token) return ""
  return `if (!window.flupcode) window.flupcode = { browserToken: ${JSON.stringify(token)} }\n`
}

/**
 * The token the harness server compares. Same precedence and path as
 * `packages/harness-server/src/browser-token.ts` (`flupcodeConfigDir`, `browserTokenFile`) and the
 * server entrypoint's `createBrowserToken`; replicated because the harness does not depend on the
 * server package.
 */
export function readDevToken(env: Record<string, string | undefined>, home: string) {
  const fromEnv = env.FLUPCODE_BROWSER_TOKEN?.trim()
  if (fromEnv) return fromEnv
  const file = join(
    env.FLUPCODE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "flupcode"),
    "browser-token",
  )
  if (!existsSync(file)) return undefined
  return readFileSync(file, "utf8").trim() || undefined
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

function trustedRequest(request: IncomingMessage) {
  return (
    LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? "") && request.headers["sec-fetch-site"] === "same-origin"
  )
}
