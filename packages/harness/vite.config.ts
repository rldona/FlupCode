import { defineConfig } from "vite"
import tailwindcss from "@tailwindcss/vite"
import solid from "vite-plugin-solid"

export default defineConfig({
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
