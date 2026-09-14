import type { RelayHostStatus } from "./connect"

/** The contract between the desktop main process (host) and the harness renderer (`window.flupcode.remote`). */

export type RemoteDevice = {
  id: string
  name: string
  createdAt: number
  lastSeen: number
  connected: boolean
  /** Whether the device registered for push notifications. */
  notifications: boolean
}

export type RemotePairing = {
  url: string
  expiresAt: number
}

export type RemoteHostState = {
  enabled: boolean
  connection: RelayHostStatus
  detail?: string
  relay: string
  hostId?: string
  hostName: string
  devices: RemoteDevice[]
  pairing?: RemotePairing
  /** Whether secrets are encrypted at rest with the OS keychain. */
  secureStorage: boolean
}

export type RemoteHostBridge = {
  state(): Promise<RemoteHostState>
  setEnabled(enabled: boolean): Promise<RemoteHostState>
  setRelay(relay: string): Promise<RemoteHostState>
  createPairing(): Promise<RemoteHostState>
  cancelPairing(): Promise<RemoteHostState>
  revokeDevice(id: string): Promise<RemoteHostState>
  onChange(listener: (state: RemoteHostState) => void): () => void
}

/** Events streamed by the desktop's native speech recognizer (`window.flupcode.speech`). */
export type SpeechEvent =
  | { type: "ready" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "end" }
  | { type: "error"; code?: string; message: string }

/**
 * Desktop dictation over the OS speech recognizer. The Web Speech API does not work in Electron
 * (Chromium's cloud service is Chrome-only and the on-device binder is missing), so the desktop
 * main process bridges macOS `SFSpeechRecognizer` instead.
 */
export type SpeechBridge = {
  start(lang?: string): Promise<void>
  stop(): Promise<void>
  cancel(): Promise<void>
  onEvent(listener: (event: SpeechEvent) => void): () => void
}

/** Control messages exchanged on stream 0 of the tunnel. */
export type RemoteControl =
  | { type: "enrolled"; deviceId: string; deviceKey: string; hostName: string }
  | { type: "device"; name: string }
  /** The phone's Web Push subscription, or null to stop notifications (ADR-0011). */
  | { type: "push-subscription"; subscription: { endpoint: string; keys: { p256dh: string; auth: string } } | null }
