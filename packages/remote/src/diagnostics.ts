import { existsSync, readFileSync } from "node:fs"
import { REDACTED, SECRET_PATTERNS } from "./secret-patterns"
import { tailLog, type ChildState } from "./supervisor"

/**
 * "Copy diagnostics" (HE-03): what a host knows about itself — versions, ports, its children and
 * the end of their logs, its configuration — as one text a user can paste into a bug report.
 *
 * Nothing secret leaves in it. Three passes see to that: the host names the secrets it holds (the
 * engine password, the UI and plugin tokens, the vault key) and every copy of them is replaced; a
 * configuration file is read as JSON and every value under a secret-looking key, or inside `headers`
 * or `env`, is replaced; and the whole text is swept for well-known credential shapes. A config file
 * that cannot be read as JSON is left out rather than copied raw.
 */

export type DiagnosticsInput = {
  title: string
  versions: Record<string, string | undefined>
  ports: Record<string, string | undefined>
  children: ChildState[]
  /** Configuration files to include, redacted; missing ones are said to be missing. */
  configs: Array<{ label: string; file: string }>
  env: NodeJS.ProcessEnv
  /** Values the host knows to be secret: replaced wherever they appear. */
  secrets: Array<string | undefined>
  lines?: number
}

export function diagnosticsBundle(input: DiagnosticsInput) {
  const sections = [
    `# ${input.title}`,
    `Generated ${new Date().toISOString()}`,
    section("Versions", entries(input.versions)),
    section("Ports", entries(input.ports)),
    section(
      "Processes",
      input.children.map((child) =>
        [
          `${child.name}: ${child.phase}${child.pid ? ` (pid ${child.pid})` : ""}, ${child.restarts} restarts`,
          ...(child.failure ? [`  last stop: ${child.failure.message}`] : []),
          `  log: ${child.log}`,
        ].join("\n"),
      ),
    ),
    section("Environment", environment(input.env)),
    ...input.configs.map((config) => section(`Config: ${config.label} (${config.file})`, [readConfig(config.file)])),
    ...input.children.map((child) =>
      section(`Log: ${child.name} (last ${input.lines ?? 200} lines)`, tailLog(child.log, input.lines ?? 200)),
    ),
  ]
  return redact(sections.join("\n\n"), input.secrets)
}

/** Every known secret value, and the shapes it travels in (`Basic base64(opencode:…)`), replaced. */
export function redact(text: string, secrets: Array<string | undefined> = []) {
  const known = knownSecrets(secrets).reduce((swept, secret) => swept.split(secret).join(REDACTED), text)
  return SECRET_PATTERNS.reduce((swept, entry) => swept.replace(entry.pattern, entry.replacement ?? REDACTED), known)
}

/**
 * A parsed configuration with every value under a secret-looking key replaced, and every value
 * under `headers` or `env`: a provider's `Authorization` or an MCP server's token can be named
 * anything there.
 */
export function redactConfig(value: unknown, hidden = false): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactConfig(entry, hidden))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactConfig(entry, hidden || SECRET_KEY.test(key) || OPAQUE_KEY.test(key)),
      ]),
    )
  if (hidden && value !== null && value !== undefined) return REDACTED
  return value
}

const SECRET_KEY = /pass(word|wd)?|secret|token|api[_-]?key|apikey|(^|[_-])key$|auth|credential|cookie|private/i
const OPAQUE_KEY = /^(headers|env|environment)$/i

function knownSecrets(values: Array<string | undefined>) {
  const plain = values.filter((value): value is string => typeof value === "string" && value.trim().length >= 8)
  // The engine password also travels as `Basic base64(opencode:password)`.
  const encoded = plain.map((value) => Buffer.from(`opencode:${value}`).toString("base64"))
  // Longest first, so a secret that contains another is replaced whole.
  return Array.from(new Set([...plain, ...encoded])).sort((a, b) => b.length - a.length)
}

function readConfig(file: string) {
  if (!existsSync(file)) return "(not present)"
  const parsed = parseJsonc(readFileSync(file, "utf8"))
  if (parsed === undefined) return "(left out: not readable as JSON)"
  return JSON.stringify(redactConfig(parsed), null, 2)
}

/** JSON with `//` and block comments and trailing commas, as OpenCode's own `opencode.jsonc` allows. */
function parseJsonc(text: string): unknown {
  const stripped = text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, string: string | undefined) => string ?? "")
    .replace(
      /("(?:\\.|[^"\\])*")|,(\s*[}\]])/g,
      (match, string: string | undefined, tail: string | undefined) => string ?? tail ?? match,
    )
  try {
    return JSON.parse(stripped)
  } catch {
    return undefined
  }
}

/** FlupCode's and OpenCode's own variables only; a value under a secret-looking name is never shown. */
function environment(env: NodeJS.ProcessEnv) {
  return Object.entries(env)
    .filter(([name]) => /^(FLUPCODE_|OPENCODE_|XDG_)/.test(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${SECRET_KEY.test(name) || /VAULT/.test(name) ? REDACTED : value}`)
}

function entries(values: Record<string, string | undefined>) {
  return Object.entries(values).map(([name, value]) => `${name}: ${value ?? "unknown"}`)
}

function section(title: string, lines: string[]) {
  return [`## ${title}`, ...(lines.length ? lines : ["(nothing)"])].join("\n")
}
