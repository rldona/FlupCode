import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installationKeyFile, readOrCreateInstallationKeyFile } from "./installation-key"
import { parseVaultKey } from "../vault"

describe("the adaptive installation key", () => {
  test("creates a restricted key file once and keeps it stable", () => {
    const directory = mkdtempSync(join(tmpdir(), "fc-adaptive-key-"))
    const file = installationKeyFile(directory)
    try {
      const key = readOrCreateInstallationKeyFile(file)
      expect(parseVaultKey(key)).toBeDefined()
      // Stability: a second read returns the same bytes, so re-captures keep their ids.
      expect(readOrCreateInstallationKeyFile(file)).toBe(key)
      // Restrictive permissions, like the browser token and the vault key.
      expect(statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
