/**
 * Pairing a browser tab with this harness (HE-01).
 *
 * A tab on FlupCode's hosted web app has no way to read the UI token from disk, so `flupcode pair`
 * (and `flupcode serve` when it starts) asks this server for a one-time code, the reader types it in
 * the tab, and the tab trades it at `POST /harness/pair` for a short-lived `ui` token kept in memory
 * and a refresh token in an `HttpOnly` cookie. Every token is bound to the origin that paired: the
 * hosted origin is let through CORS only with one (`api.ts`), and the server checks it on every call.
 *
 * Codes and access tokens live in memory only: a restarted server forgets them and the tab refreshes.
 * The refresh tokens are kept, as hashes, in `paired-tabs.json` beside the UI token (not in
 * `harness.sqlite`), so a tab stays paired across a restart until it is revoked or goes unused.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { flupcodeConfigDir } from "./browser-token"

/** How long a code can be typed in. */
export const PAIRING_CODE_TTL = 5 * 60_000
/** How long a tab's `ui` token works before the tab refreshes it. */
export const PAIRED_TOKEN_TTL = 15 * 60_000
/** How long a refresh token works unused; each refresh issues a new one. */
export const PAIRED_REFRESH_TTL = 30 * 24 * 60 * 60_000
/** Wrong codes allowed per minute, across every caller, before the server stops listening for a while. */
export const PAIRING_ATTEMPTS = 5
const ATTEMPT_WINDOW = 60_000
/**
 * Two tabs of one browser share the cookie and can refresh at the same moment; the token the first
 * one retired is still accepted this long. Later, a retired token is a replay and ends the pairing.
 */
const RETIRED_GRACE = 30_000
const CODES_KEPT = 5
// No 0/O, 1/I/L: a code is read off a terminal and typed by hand.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

export const PAIR_COOKIE = "flupcode_pair"

export function pairedTabsFile(dir: string = flupcodeConfigDir()) {
  return join(dir, "paired-tabs.json")
}

type StoredTab = {
  id: string
  origin: string
  created: number
  expires: number
  refresh: string
  /** Refresh tokens this tab already traded, with when, for the grace window and replay detection. */
  retired: Array<{ hash: string; at: number }>
}

export type PairingGrant = { token: string; expiresAt: number; refresh: string; refreshExpiresAt: number }
export type PairingRefusal = { refused: "invalid_code" | "rate_limited" | "not_paired"; retryAfter?: number }

export function createPairing(input: { file?: string; now?: () => number } = {}) {
  const file = input.file ?? pairedTabsFile()
  const now = input.now ?? Date.now
  const codes = new Map<string, number>()
  const access = new Map<string, { tab: string; origin: string; expires: number }>()
  const failures: number[] = []
  const tabs = readTabs(file)

  const save = () => writeTabs(file, tabs)
  const prune = () => {
    const at = now()
    codes.forEach((expires, code) => expires <= at && codes.delete(code))
    access.forEach((entry, token) => entry.expires <= at && access.delete(token))
    const live = tabs.filter((tab) => tab.expires > at)
    if (live.length === tabs.length) return
    tabs.splice(0, tabs.length, ...live)
    save()
  }

  const grant = (tab: StoredTab): PairingGrant => {
    const token = randomBytes(32).toString("base64url")
    const refresh = randomBytes(32).toString("base64url")
    const at = now()
    access.set(digest(token), { tab: tab.id, origin: tab.origin, expires: at + PAIRED_TOKEN_TTL })
    tab.refresh = digest(refresh)
    tab.expires = at + PAIRED_REFRESH_TTL
    save()
    return { token, expiresAt: at + PAIRED_TOKEN_TTL, refresh, refreshExpiresAt: tab.expires }
  }

  const forget = (id: string) => {
    access.forEach((entry, token) => entry.tab === id && access.delete(token))
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index >= 0) tabs.splice(index, 1)
    save()
  }

  return {
    /** A new one-time code; the oldest is dropped past a handful, so they cannot pile up. */
    issueCode() {
      prune()
      const code = Array.from(randomBytes(8), (byte) => ALPHABET[byte % ALPHABET.length]).join("")
      const expiresAt = now() + PAIRING_CODE_TTL
      codes.set(code, expiresAt)
      Array.from(codes.keys())
        .slice(0, Math.max(0, codes.size - CODES_KEPT))
        .forEach((old) => codes.delete(old))
      return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt }
    },

    /** Trades a code, once, for a token bound to `origin`. */
    exchange(code: string, origin: string): PairingGrant | PairingRefusal {
      prune()
      const at = now()
      const recent = failures.filter((time) => time > at - ATTEMPT_WINDOW)
      failures.splice(0, failures.length, ...recent)
      if (failures.length >= PAIRING_ATTEMPTS)
        return { refused: "rate_limited", retryAfter: Math.ceil((failures[0]! + ATTEMPT_WINDOW - at) / 1000) }
      const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "")
      if (!codes.has(normalized)) {
        failures.push(at)
        return { refused: "invalid_code" }
      }
      codes.delete(normalized)
      const tab: StoredTab = { id: randomUUID(), origin, created: at, expires: at, refresh: "", retired: [] }
      tabs.push(tab)
      return grant(tab)
    },

    /** A new token and a new refresh token for the tab whose cookie this is, from its own origin. */
    refresh(refresh: string | undefined, origin: string): PairingGrant | PairingRefusal {
      prune()
      if (!refresh) return { refused: "not_paired" }
      const hash = digest(refresh)
      const current = tabs.find((tab) => tab.refresh === hash)
      if (current) {
        if (current.origin !== origin) return { refused: "not_paired" }
        current.retired = [...current.retired, { hash, at: now() }].slice(-CODES_KEPT)
        return grant(current)
      }
      const retired = tabs.find((tab) => tab.retired.some((entry) => entry.hash === hash))
      if (!retired) return { refused: "not_paired" }
      const at = now()
      const entry = retired.retired.find((item) => item.hash === hash)!
      // A token traded a moment ago by a sibling tab of the same browser.
      if (retired.origin === origin && at - entry.at <= RETIRED_GRACE) {
        retired.retired = [...retired.retired, { hash: retired.refresh, at }].slice(-CODES_KEPT)
        return grant(retired)
      }
      // Anything later is a copy being replayed: the pairing it came from is ended.
      forget(retired.id)
      return { refused: "not_paired" }
    },

    /** Whether `token` is a live paired token, used from the origin it was given to. */
    verify(token: string | undefined, origin: string | undefined) {
      if (!token || !origin) return false
      const entry = access.get(digest(token))
      if (!entry) return false
      if (entry.expires <= now()) {
        access.delete(digest(token))
        return false
      }
      return entry.origin === origin
    },

    /** Ends every pairing: every tab has to type a new code. */
    revokeAll() {
      const count = tabs.length
      access.clear()
      codes.clear()
      tabs.splice(0)
      save()
      return count
    },

    /** The tabs paired now, without any secret. */
    tabs() {
      prune()
      return tabs.map((tab) => ({ id: tab.id, origin: tab.origin, created: tab.created, expires: tab.expires }))
    },
  }
}

export type Pairing = ReturnType<typeof createPairing>

const digest = (token: string) => createHash("sha256").update(token).digest("hex")

/** A file that cannot be read pairs nothing: every tab types a new code, and the server still starts. */
function readTabs(file: string): StoredTab[] {
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { tabs?: StoredTab[] }
    return Array.isArray(parsed.tabs) ? parsed.tabs : []
  } catch {
    return []
  }
}

function writeTabs(file: string, tabs: StoredTab[]) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  // Written aside and moved, so a crash never leaves half a file that would unpair every tab.
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ tabs }, null, 2), { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
}

/** The refresh cookie: only for the pairing routes, never readable by the page, kept per top site. */
export function pairCookie(value: string, expiresAt: number, now = Date.now()) {
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000))
  return `${PAIR_COOKIE}=${value}; Path=/harness/pair; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None; Partitioned`
}

export function pairCookieFrom(request: Request) {
  return (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${PAIR_COOKIE}=`))
    ?.slice(PAIR_COOKIE.length + 1)
}
