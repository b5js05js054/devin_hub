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
  /** Latest plan-card expiry across the account's cards; null while no card is bound. */
  readonly planExpiresAt: string | null
  /** Last backend message, e.g. the reason a heartbeat was rejected. */
  readonly message: string
}

/** A benefit-pack product listed in the client shop; buying one grants a plan card. */
export interface RelayShopProduct {
  readonly id: number
  readonly name: string
  readonly description: string
  /** Free-model days granted per purchase. */
  readonly durationDays: number
  /** Price in wallet currency units. */
  readonly price: number
  /** Plan cards issued per purchase. */
  readonly cardsPerPurchase: number
}

/** Shop catalog payload: products plus the wallet currency for display. */
export interface RelayShopCatalog {
  readonly currency: string
  readonly items: readonly RelayShopProduct[]
}

/** A completed shop order: balance charge or card redemption that issued plan cards. */
export interface RelayShopOrder {
  readonly id: number
  readonly productId: number
  readonly productName: string
  readonly durationDays: number
  readonly payMethod: 'balance' | 'card'
  readonly amount: number
  readonly cardCodes: readonly string[]
  readonly refunded: boolean
  readonly createdAt: string | null
}

/** Outcome of a shop purchase; the issued card codes sit inside the order. */
export interface RelayShopBuyOutcome {
  readonly ok: boolean
  readonly message: string
  readonly order: RelayShopOrder | null
}

/** Outcome of an activation or redemption attempt. */
export interface RelayLicenseOutcome {
  readonly ok: boolean
  /** Backend or local message suitable for display. */
  readonly message: string
}
