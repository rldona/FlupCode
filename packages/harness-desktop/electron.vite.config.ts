import { defineConfig } from "electron-vite"

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      // A sandboxed preload runs as a classic script, so it cannot be an ES module: Electron would
      // refuse it with "Cannot use import statement outside a module" and the window would come up
      // with no bridge at all. `.cjs` because the package is `type: module`.
      rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } },
    },
  },
})
