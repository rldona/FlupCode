/**
 * The environment a process this server starts inherits (TI-10).
 *
 * External tasks, verify steps and git or gh (hence a repository's own hooks) run code this server
 * does not control. The desktop hands the server its bearer tokens, the engine's credentials and, on
 * Windows and Linux, the vault key through the environment; none of them is any child's business.
 * Everything else is passed on, so a login shell still finds the user's tools.
 */
const SECRETS = [
  "FLUPCODE_BROWSER_TOKEN",
  "FLUPCODE_PLUGIN_TOKEN",
  "FLUPCODE_ENGINE_AUTH",
  "FLUPCODE_VAULT_KEY",
  "OPENCODE_SERVER_PASSWORD",
]

export function childEnv(extra: Record<string, string> = {}) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !SECRETS.includes(name))),
    ...extra,
  }
}
