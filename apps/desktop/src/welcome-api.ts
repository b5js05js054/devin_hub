/** Operations available to the isolated native welcome renderer. */

import type { ProductEventMap } from '@deepseek-ai/dsh-client-product-analytics/types'
import type { DesktopLocale } from './locale.ts'

/** Private native welcome channels, installed only while its window exists. */
export const WELCOME_IPC = {
  activate: 'dsh-welcome:activate',
  signOut: 'dsh-welcome:sign-out',
  read: 'dsh-welcome:read',
  analytics: 'dsh-welcome:analytics',
  analyticsEnabled: 'dsh-welcome:analytics-enabled',
  start: 'dsh-welcome:start',
  cancel: 'dsh-welcome:cancel',
  copyLink: 'dsh-welcome:copy-link',
  state: 'dsh-welcome:state',
} as const

/** Failure class of a relay sign-in or activation, localized by the renderer. */
export type RelayWelcomeError = 'not-configured' | 'network' | 'rejected' | 'failed'

/** Relay account and card-key facts the welcome window renders; never carries tokens or the card key. */
export interface RelayWelcomeState {
  /** Whether the Host has a relay backend origin. */
  readonly configured: boolean
  readonly signedIn: boolean
  readonly email: string
  readonly signIn: {
    readonly phase: 'idle' | 'waiting-browser' | 'exchanging' | 'failed'
    readonly authorizeUrl?: string
    readonly error?: RelayWelcomeError
  }
  /** Signed in with an activated, unexpired card. */
  readonly licensed: boolean
  /** Last backend message about the card, empty when none. */
  readonly licenseMessage: string
}

/** Activation outcome with the backend's own text. */
export interface RelayWelcomeActivation {
  readonly ok: boolean
  readonly message: string
}

type WelcomeEventName = 'auth_page_view' | 'auth_page_click'

/** Host-owned operations used by the welcome window. */
export interface WelcomeOperations {
  /** @param eventName - allowed welcome event. @param attributes - approved fields without credentials. */
  analytics?<K extends WelcomeEventName>(eventName: K, attributes: ProductEventMap[K]): Promise<void>
  /** @returns the Host's current effective collection policy. */
  analyticsEnabled(): Promise<boolean>
  /** @returns relay state after opening a browser sign-in attempt. */
  startSignIn(): Promise<RelayWelcomeState>
  /** @returns the settled state after abandoning the running attempt. */
  cancelSignIn(): Promise<RelayWelcomeState>
  /** Copy the running attempt's website link to the system clipboard. */
  copySignInLink(): Promise<void>
  /** @returns the current relay state. */
  readRelay(): Promise<RelayWelcomeState>
  /** @param cardKey - card key to bind to this device. @returns the outcome; success enters the workspace. */
  activate(cardKey: string): Promise<RelayWelcomeActivation>
  /** @returns the state after signing out of the relay account. */
  signOut(): Promise<RelayWelcomeState>
}

/** The renderer receives localized copy, login operations, and safe account snapshots. */
export type WelcomeApi = DesktopLocale & WelcomeOperations & {
  /** @param listener - relay snapshot recipient. @returns subscription disposer. */
  onRelayState(listener: (state: RelayWelcomeState) => void): () => void
}

/** Authentication facts supplied at cold start or after a completed sign-out. */
export interface WelcomeAuthentication {
  /** Relay account signed in with a valid card key. */
  readonly relayReady: boolean
}

/**
 * Decide whether a startup or sign-out requires the welcome entry.
 * @param authentication - current relay facts.
 * @returns true until the relay account is signed in with a valid card key.
 */
export function needsWelcome(authentication: WelcomeAuthentication): boolean {
  return !authentication.relayReady
}
