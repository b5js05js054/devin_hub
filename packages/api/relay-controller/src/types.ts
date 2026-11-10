/** Relay Remote values carry neither the session token nor the license token. */
import type { RelayAccountErrorCode, RelayAccountView, RelayUpdateInfo } from '@deepseek-ai/dsh-relay-account/types'
import type { RelayLicenseView } from '@deepseek-ai/dsh-relay-license/types'

export type { RelayAccountErrorCode, RelayAccountProfile, RelayAccountView, RelayUpdateInfo, RelayUploadProgress } from '@deepseek-ai/dsh-relay-account/types'
export type { RelayLicenseOutcome, RelayLicenseView } from '@deepseek-ai/dsh-relay-license/types'

/** Account and license state shown on the relay page. */
export interface RelayView {
  readonly account: RelayAccountView
  /** Absent while signed out. */
  readonly license: RelayLicenseView | null
  /** Whether the Host has a backend origin configured. */
  readonly configured: boolean
}

/** Avatar chosen at registration, base64 encoded for the JSON wire. */
export interface RelayAvatarUpload {
  readonly filename: string
  readonly base64: string
}

/** One model's spend and traffic inside the usage window. */
export interface RelayUsageModel {
  readonly model: string
  readonly label: string
  readonly cost: number
  readonly requests: number
  readonly tokens: number
}

/** One completed model request, with cached and uncached input kept in separate buckets. */
export interface RelayUsageRecord {
  readonly time: string
  readonly model: string
  readonly label: string
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cost: number
  readonly free: boolean
  readonly estimated: boolean
}

/** Newest-first request records and the backend's complete pagination position. */
export interface RelayUsageRecords {
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly items: readonly RelayUsageRecord[]
}

/** Card usage totals, model breakdown and request records for the requested window. */
export interface RelayUsage {
  readonly currency: string
  readonly days: number
  readonly totalCost: number
  readonly todayCost: number
  readonly totalRequests: number
  readonly todayRequests: number
  readonly totalTokens: number
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly outputTokens: number
  readonly cacheHitRate: number
  readonly models: readonly RelayUsageModel[]
  readonly records: RelayUsageRecords
}

/** Usage lookup result; failures are values so the page can show the backend message. */
export type RelayUsageResult =
  | { readonly ok: true; readonly usage: RelayUsage }
  | { readonly ok: false; readonly message: string }

/** Published client release lookup; failures are values so the Desktop can stay silent on automatic checks. */
export type RelayUpdateResult =
  | { readonly ok: true; readonly update: RelayUpdateInfo | null }
  | { readonly ok: false; readonly code: RelayAccountErrorCode; readonly message: string }

/** Result of a sign-in, sign-up, or sign-out command; failures are values so the page can localize by code. */
export type RelayCommandResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: RelayAccountErrorCode; readonly message: string }
