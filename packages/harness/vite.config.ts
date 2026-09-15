import { readFileSync } from "node:fs"
import { defineConfig } from "vite"
import tailwindcss from "@tailwindcss/vite"
import solid from "vite-plugin-solid"

// The engine version this client was generated from. `/global/health` reports the version of the
// connected engine, so a mismatch means the UI and the engine may have drifted (ADR-0009).
const sdk = JSON.parse(readFileSync(new URL("../sdk/js/package.json", import.meta.url), "utf8")) as {
  version: string
}

export default defineConfig({
  define: {
    __FLUPCODE_ENGINE_VERSION__: JSON.stringify(sdk.version),
  },
  plugins: [tailwindcss(), solid()],
  server: {
    host: "0.0.0.0",
    port: 4444,
    allowedHosts: true,
  },
  build: {
    target: "esnext",
    sourcemap: true,
  },
})
