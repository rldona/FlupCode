/** Test support for TI-10: the harness's secrets in this process, and whether a child printed one. */

// The harness's own secrets, as the desktop hands them to this process (TI-10).
const SECRETS = {
  FLUPCODE_BROWSER_TOKEN: "ui-token-secret",
  FLUPCODE_PLUGIN_TOKEN: "plugin-token-secret",
  FLUPCODE_ENGINE_AUTH: "engine-auth-secret",
  FLUPCODE_VAULT_KEY: "vault-key-secret",
}

/** Runs `body` with the secrets in this process's environment, as the desktop starts the server. */
export async function withSecrets<T>(body: () => Promise<T>) {
  Object.assign(process.env, SECRETS)
  try {
    return await body()
  } finally {
    for (const name of Object.keys(SECRETS)) delete process.env[name]
  }
}

export const leaked = (output: string) => Object.values(SECRETS).filter((secret) => output.includes(secret))
