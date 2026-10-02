import { readFileSync } from "node:fs"
import { defineConfig } from "vite"
import tailwindcss from "@tailwindcss/vite"
import solid from "vite-plugin-solid"
import { devTokenPlugin } from "./src/vite-dev-token"

// The OpenCode 2 version this build is pinned to: `@opencode/client` follows the binary's pin
// (ADR-0027). The engine reports its own version, so a mismatch means one started some other way.
const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>
}

export default defineConfig({
  define: {
    __FLUPCODE_ENGINE_VERSION__: JSON.stringify(manifest.dependencies["@opencode/client"]),
  },
  // `vite` only: a plain tab gets the harness bearer the desktop would hand it (AH-A05).
  plugins: [tailwindcss(), solid(), devTokenPlugin()],
  // The markdown renderer parses and highlights off the main thread, and a worker bundled as IIFE
  // cannot be code-split alongside the app.
  worker: { format: "es" },
  server: {
    host: "0.0.0.0",
    port: 4444,
    allowedHosts: true,
  },
  build: {
    target: "esnext",
    sourcemap: true,
    rollupOptions: {
      output: {
        // The third-party code the first screen needs, and the Spanish dictionary, ride apart from the
        // app's own code: they change far less often than it does, so a release leaves them cached. They
        // still load at startup, and `script/bundle-size.ts` counts them in what startup costs (UX-00).
        manualChunks: (id) => {
          if (/\/node_modules\/.*\/(solid-js|@opencode\/client|morphdom|dompurify)\//.test(id)) return "vendor"
          if (id.endsWith("/src/i18n.ts")) return "i18n"
        },
      },
    },
  },
})
