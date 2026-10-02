import { createSignal } from "solid-js"
import { anonymousFetch, hostsHarnessToken, setPairedToken, setPairingRestore } from "./transport"

/**
 * Pairing this tab with FlupCode's harness on this computer (HE-01).
 *
 * The hosted web app cannot read the harness's token from disk, so `flupcode serve` (or `flupcode
 * pair`) prints a one-time code, the reader types it here, and the harness answers with a short-lived
 * token, kept in memory and nowhere else, and a refresh cookie it alone can read. A reload or a new
 * tab trades that cookie for a new token; a token about to expire is renewed the same way.
 */

export type PairResult = "paired" | "invalid_code" | "rate_limited" | "unreachable"

/** Bumped when this tab becomes paired or stops being so, so whoever reads the harness reconnects. */
const [epoch, setEpoch] = createSignal(0)
const [paired, setPaired] = createSignal(false)
export { epoch as pairingEpoch, paired as tabPaired }

/** A minute of margin, so a request is never sent with a token that expires on the way. */
const RENEW_BEFORE = 60_000
let renewal: ReturnType<typeof setTimeout> | undefined

/** Trades a code the reader typed for this tab's token. */
export async function pairTab(baseUrl: string, code: string): Promise<PairResult> {
  const response = await pairRequest(baseUrl, "/harness/pair", { code })
  if (!response) return "unreachable"
  if (response.status === 429) return "rate_limited"
  if (!response.ok) return "invalid_code"
  return (await accept(baseUrl, response)) ? "paired" : "unreachable"
}

/**
 * Restores this tab's pairing from the refresh cookie, when it has one: on load, and before the token
 * runs out. A page the desktop hands the token to never pairs.
 */
export function restorePairing(baseUrl: string) {
  const restore = refresh(baseUrl)
  setPairingRestore(restore)
  return restore
}

async function refresh(baseUrl: string) {
  if (hostsHarnessToken()) return false
  const response = await pairRequest(baseUrl, "/harness/pair/refresh")
  if (response?.ok) return accept(baseUrl, response)
  // Refused: the pairing ended (revoked, replayed or unused for too long). Unreachable: keep what we
  // have; the next request says whether the harness is there at all.
  if (response) forget()
  return false
}

function forget() {
  clearTimeout(renewal)
  setPairedToken(undefined)
  if (!paired()) return
  setPaired(false)
  setEpoch(epoch() + 1)
}

async function accept(baseUrl: string, response: Response) {
  const body = (await response.json().catch(() => undefined)) as { data?: { token?: string; expiresAt?: number } } | undefined
  const token = body?.data?.token
  const expiresAt = body?.data?.expiresAt
  if (!token || !expiresAt) return false
  setPairedToken(token)
  // A renewed token needs no reconnection: the open stream was admitted with the previous one.
  if (!paired()) {
    setPaired(true)
    setEpoch(epoch() + 1)
  }
  clearTimeout(renewal)
  renewal = setTimeout(() => void restorePairing(baseUrl), Math.max(5_000, expiresAt - Date.now() - RENEW_BEFORE))
  return true
}

/** The cookie goes along (`include`): it is the harness's, on another origin than this page. */
function pairRequest(baseUrl: string, path: string, body?: unknown) {
  return anonymousFetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    credentials: "include",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }).catch(() => undefined)
}
