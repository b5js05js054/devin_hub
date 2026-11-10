/** Client-safe types of the relay license service; the license token and full card key never appear here. */

/** Snapshot of the card-key license for display. */
export interface RelayLicenseView {
  readonly activated: boolean
  /** Activated and the card has not expired. */
  readonly valid: boolean
  /** Card key with the middle masked, e.g. `ABCD****WXYZ`; empty while not activated. */
  readonly cardKey: string
  readonly deviceId: string
  readonly deviceName: string
  /** ISO card expiry; null for a permanent card or while not activated. */
  readonly cardExpiresAt: string | null
  readonly durationDays: number
  readonly billingEnabled: boolean
  readonly balance: number
  readonly currency: string
  /** Holds an unexpired activation card; without one only balance-billed premium models work. */
  readonly planActive: boolean
  /** Last backend message, e.g. the reason a heartbeat was rejected. */
  readonly message: string
}

/** Outcome of an activation or redemption attempt. */
export interface RelayLicenseOutcome {
  readonly ok: boolean
  /** Backend or local message suitable for display. */
  readonly message: string
}
