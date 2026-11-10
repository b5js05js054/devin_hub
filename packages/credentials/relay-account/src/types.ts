/** Client-safe types of the relay account service; no credentials appear here. */

/** Public profile of the signed-in relay user. */
export interface RelayAccountProfile {
  /** Backend user id. */
  readonly id: number
  /** Login email. */
  readonly email: string
  /** Absolute avatar image URL on the backend origin; null when the user has none. */
  readonly avatarUrl: string | null
}

/** Phase of the most recent registration upload. */
export type RelayUploadPhase = 'idle' | 'uploading' | 'processing' | 'done' | 'error'

/** Registration upload progress; `sent` and `total` count request body bytes. */
export interface RelayUploadProgress {
  readonly phase: RelayUploadPhase
  readonly sent: number
  readonly total: number
  /** Failure reason code when `phase` is `error`. */
  readonly code?: RelayAccountErrorCode
}

/** Browser sign-in progress; `authorizeUrl` is the page the user must open while waiting. */
export interface RelaySignInView {
  readonly phase: 'idle' | 'waiting-browser' | 'exchanging' | 'failed'
  readonly authorizeUrl?: string
  readonly code?: RelayAccountErrorCode
}

/** Snapshot of account state; the session token is never part of it. */
export interface RelayAccountView {
  readonly status: 'signed-out' | 'signed-in'
  readonly profile: RelayAccountProfile | null
  /** ISO expiry of the stored session; null while signed out. */
  readonly expiresAt: string | null
  readonly upload: RelayUploadProgress
  readonly signIn: RelaySignInView
  /** Whether the signed-in user has a local custom background. */
  readonly hasBackground: boolean
}

/** Failure classes of account operations. */
export type RelayAccountErrorCode =
  | 'not-configured'
  | 'network'
  | 'unauthorized'
  | 'rejected'
  | 'invalid-response'
  | 'invalid-image'
  | 'signed-out'
  | 'storage'

/** Published client release for the running platform; the download URL and checksum come from the backend. */
export interface RelayUpdateInfo {
  readonly version: string
  readonly url: string
  /** Lowercase hex SHA-256 of the package; empty when the operator published none. */
  readonly sha256: string
  readonly mandatory: boolean
  readonly note: string
}

/** Image chosen by the user for registration. */
export interface RelayImageInput {
  readonly bytes: Uint8Array
  readonly filename: string
}

/** Local background image read back for display. */
export interface RelayBackground {
  readonly mime: string
  readonly bytes: Uint8Array
}
