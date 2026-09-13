import { createSignal } from "solid-js"
import { fromBase64Url, toBase64Url } from "@flupcode/remote"
import { t } from "./i18n"
import { readStorage, STORAGE_KEYS, writeStorage } from "./storage"

/**
 * Push notifications on the phone for remote control (ADR-0011): permission, a Web Push
 * subscription with the relay's VAPID key, and whether the user turned them on.
 */

export type PushStatus =
  /** The browser has no Web Push (or no service worker, e.g. in development). */
  | "unsupported"
  /** iOS only delivers Web Push to web apps added to the Home Screen. */
  | "install"
  | "off"
  | "on"
  | "blocked"

type SubscriptionJson = { endpoint: string; keys: { p256dh: string; auth: string } }

// The service worker is only registered in production builds (entry.tsx).
const supported = () =>
  import.meta.env.PROD &&
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  typeof Notification !== "undefined"

const iosBrowser = () =>
  typeof navigator !== "undefined" &&
  /iPhone|iPad|iPod/.test(navigator.userAgent) &&
  !window.matchMedia?.("(display-mode: standalone)").matches &&
  (navigator as Navigator & { standalone?: boolean }).standalone !== true

const [wanted, setWanted] = createSignal(readStorage(STORAGE_KEYS.remotePush, false))
const [permission, setPermission] = createSignal(
  typeof Notification === "undefined" ? "default" : Notification.permission,
)
const [busy, setBusy] = createSignal(false)

export const pushStatus = (): PushStatus => {
  if (iosBrowser()) return "install"
  if (!supported()) return "unsupported"
  if (permission() === "denied") return "blocked"
  return wanted() && permission() === "granted" ? "on" : "off"
}

export const pushBusy = busy

function relayHttp(relay: string) {
  return relay.replace(/^ws(s?):\/\//, "http$1://").replace(/\/$/, "")
}

async function relayKey(relay: string) {
  const response = await fetch(`${relayHttp(relay)}/push/key`)
  if (!response.ok) throw new Error(t("This relay does not deliver notifications"))
  const body = (await response.json()) as { publicKey?: string }
  if (!body.publicKey) throw new Error(t("This relay does not deliver notifications"))
  return body.publicKey
}

function toJson(subscription: PushSubscription): SubscriptionJson {
  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
  return {
    endpoint: json.endpoint ?? subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
  }
}

/** A subscription for the relay's key, reusing the current one when the key matches. */
async function subscribe(relay: string) {
  const registration = await navigator.serviceWorker.ready
  const key = await relayKey(relay)
  const existing = await registration.pushManager.getSubscription()
  const existingKey = existing?.options.applicationServerKey
  if (existing && existingKey && toBase64Url(new Uint8Array(existingKey)) === key) return toJson(existing)
  await existing?.unsubscribe()
  return toJson(
    await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(key) }),
  )
}

/** The subscription to give a host after connecting, if notifications are on. */
export async function currentSubscription(relay: string) {
  if (pushStatus() !== "on") return undefined
  return subscribe(relay).catch(() => undefined)
}

/** Asks for permission (needs a tap) and subscribes. Resolves with the subscription, if any. */
export async function enablePush(relay: string) {
  if (!supported()) return undefined
  setBusy(true)
  try {
    const result = await Notification.requestPermission()
    setPermission(result)
    if (result !== "granted") return undefined
    const subscription = await subscribe(relay)
    setWanted(true)
    writeStorage(STORAGE_KEYS.remotePush, true)
    return subscription
  } finally {
    setBusy(false)
  }
}

export async function disablePush() {
  setWanted(false)
  writeStorage(STORAGE_KEYS.remotePush, false)
  if (!supported()) return
  const registration = await navigator.serviceWorker.getRegistration()
  await (await registration?.pushManager.getSubscription())?.unsubscribe()
}
