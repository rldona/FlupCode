import type { RelayHostStatus } from "./connect"

/** The contract between the desktop main process (host) and the harness renderer (`window.flupcode.remote`). */

export type RemoteDevice = {
  id: string
  name: string
  createdAt: number
  lastSeen: number
  connected: boolean
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

/** Control messages exchanged on stream 0 of the tunnel. */
export type RemoteControl =
  | { type: "enrolled"; deviceId: string; deviceKey: string; hostName: string }
  | { type: "device"; name: string }
