# ADR-0011: Push notifications for remote control

- **Status:** Accepted
- **Date:** 2026-09-13
- **Extends:** ADR-0010

## Context

With remote control (ADR-0010) a phone only learns that a session needs it while the web app is open
and connected. A turn can take minutes, so the user leaves the phone and misses the moment the agent
asks for a permission, asks a question or finishes. Claude Code's mobile app notifies in those
cases; FlupCode's phone client is a web app, so the mechanism is **Web Push**.

Web Push has three parties: the browser's push service (FCM, Mozilla, Apple, WNS), a sender that
signs requests with a VAPID key pair, and a payload encrypted for the subscription. Constraints:

- A browser subscription is tied to one VAPID public key. One phone can be paired with several
  computers, so every host must send with the **same** key — the private key cannot live on hosts.
- Content must stay end-to-end: the relay must not read what the agent is doing.
- iOS delivers Web Push only to web apps added to the Home Screen (iOS 16.4+).

## Decision

### Parties

```
 engine ──events──▶ host (desktop / flupcode remote)
                      │  encrypts payload for each subscribed phone (RFC 8291, aes128gcm)
                      ▼
                    relay ── signs VAPID JWT (RFC 8292), POSTs opaque body ──▶ push service ──▶ phone
```

- **Relay** holds the VAPID key pair (`RELAY_VAPID_PUBLIC_KEY`, `RELAY_VAPID_PRIVATE_KEY`,
  `RELAY_VAPID_SUBJECT`) and exposes the public key at `GET /push/key` (CORS `*`). An authenticated
  host sends `{t:"push", id, endpoint, body, ttl, urgency}` on its relay socket; the relay answers
  `{t:"push-result", id, status}` with the push service's HTTP status. The relay only delivers to
  browser push services over HTTPS (FCM, `*.push.services.mozilla.com`, `*.push.apple.com`,
  `*.notify.windows.com`), caps bodies at 4096 bytes and rate-limits each host (30 per minute).
- **Host** (`createRemoteHost`) stores one subscription per paired device, received as a
  `push-subscription` control message over the encrypted tunnel (`null` turns it off). It watches
  the engine's `/api/event` stream and, for every subscribed device, encrypts a notification and asks
  the relay to deliver it. A `404`/`410` from the push service drops that subscription.
- **Phone** (web app) subscribes with the relay's public key after a tap on **Turn on**, and sends
  the subscription to the connected host, again on every reconnect. The service worker shows the
  notification in the phone's language and opens `/?session=<id>&host=<hostId>` when tapped,
  switching computer if needed. It shows nothing while a FlupCode window is focused.

### What is notified

| Event | Notification | Urgency, TTL |
| --- | --- | --- |
| `permission.v2.asked` | Needs your permission: `<action>: <resources>` | high, 12 h |
| `question.v2.asked` | Has a question: `<first question>` | high, 12 h |
| `session.next.step.ended` with `finish` other than `tool-calls`, and no new step within 2.5 s | Finished | normal, 1 h |
| `session.next.step.failed` | Stopped with an error | normal, 12 h |

The payload is `{kind, host, hostName, sessionID, session, detail?}` (session title, clipped), so the
wording is localized on the phone.

## Consequences

- Phones get notified with the app closed and the screen locked, from any paired computer, without
  the relay or the push service being able to read the content.
- The relay sees push endpoints, timing and body sizes — metadata, not content — and gains an
  outbound HTTP path, limited to push services and rate-limited.
- The VAPID private key is operational state of the relay: losing or rotating it invalidates every
  subscription; phones resubscribe when they next connect with notifications on.
- Only the computer that is running and connected to the relay can notify; a sleeping computer
  sends nothing, like remote control itself.
- Self-hosted relays without VAPID keys answer `404` on `/push/key`; the phone reports that the relay
  does not deliver notifications.
- A notification is best effort: push services may delay or drop messages, and iOS requires the
  Home Screen app.
