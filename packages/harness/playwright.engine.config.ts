import { defineConfig } from "@playwright/test"

/**
 * The live-engine project (V2-43): the app against a real OpenCode 2 engine instead of mocked routes.
 * `e2e-engine/fixture.ts` starts the pinned 2.x binary with the stub model and serves it, password
 * included, on port 4197; the specs drive what a reader does there (send, stream, a permission, a
 * question, the MCP list, the queue). One worker: every spec shares the one engine and its model.
 *
 *   bun run test:e2e:engine
 */
export default defineConfig({
  testDir: "./e2e-engine",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://localhost:4173",
  },
  webServer: [
    {
      command: "bun e2e-engine/fixture.ts",
      url: "http://127.0.0.1:4197/__fixture",
      env: { FLUPCODE_CONTRACT_LINE: "v2" },
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: "pipe",
    },
    {
      command: "bun run build && bun run preview --port 4173 --strictPort",
      url: "http://localhost:4173",
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
})
