import type { ProductEvent } from '@deepseek-ai/dsh-client-product-analytics/types'
/** Native welcome operations using the shared Web authentication and RPC APIs. */

import { randomUUID } from 'node:crypto'
import { parseRelayUpdate, type RelayUpdate } from './relay-update.ts'
import type { RelayWelcomeActivation, RelayWelcomeError, RelayWelcomeState } from './welcome-api.ts'

/** Metadata needed before the native entry or workspace becomes visible. */
export interface WelcomeState {
  /** Relay account signed in; an activation card or balance is only needed per model, not to enter. */
  readonly relayReady: boolean
  readonly localePreference: string | null
}

/** Relay account operations over the Host's `relay` namespace. */
export interface DesktopRelayBackend {
  /** @returns the current relay account and card-key state. */
  state(): Promise<RelayWelcomeState>
  /** @returns state after starting a browser sign-in; a refused start shows as a failed attempt. */
  start(): Promise<RelayWelcomeState>
  /** @returns state after abandoning the running browser sign-in. */
  cancel(): Promise<RelayWelcomeState>
  /** @param cardKey - card key to bind. @returns the backend outcome. */
  activate(cardKey: string): Promise<RelayWelcomeActivation>
  /** @returns state after signing out. */
  signOut(): Promise<RelayWelcomeState>
}

/** Narrow operations available to the native welcome flow. */
export interface DesktopWelcomeBackend {
  /** @returns the current Host policy; every read observes live configuration. */
  analyticsEnabled(): Promise<boolean>
  readonly relay: DesktopRelayBackend
  /** @returns the client release published by the backend, or null when none exists or the lookup failed. */
  checkUpdate(): Promise<RelayUpdate | null>
  /** @param event - desktop-owned fields. @returns after local Host intake. */
  report(event: ProductEvent): Promise<void>
  /** @returns relay readiness and the shared language preference. */
  read(): Promise<WelcomeState>
  /** @returns The saved UI language without account or provider requests. */
  readLocalePreference(): Promise<string | null>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorOf(code: unknown): RelayWelcomeError {
  return code === 'not-configured' || code === 'network' ? code : code === 'rejected' ? 'rejected' : 'failed'
}

function relayState(value: unknown): RelayWelcomeState {
  if (!record(value) || !record(value.account) || typeof value.configured !== 'boolean') throw new Error('desktop welcome: invalid relay state')
  const account = value.account
  const signIn = record(account.signIn) ? account.signIn : { phase: 'idle' }
  const profile = record(account.profile) ? account.profile : undefined
  const license = record(value.license) ? value.license : undefined
  const phase = signIn.phase === 'waiting-browser' || signIn.phase === 'exchanging' || signIn.phase === 'failed' ? signIn.phase : 'idle'
  return {
    configured: value.configured,
    signedIn: account.status === 'signed-in',
    email: typeof profile?.email === 'string' ? profile.email : '',
    signIn: {
      phase,
      ...(typeof signIn.authorizeUrl === 'string' ? { authorizeUrl: signIn.authorizeUrl } : {}),
      ...(phase === 'failed' ? { error: errorOf(signIn.code) } : {}),
    },
    licensed: license?.valid === true,
    licenseMessage: typeof license?.message === 'string' ? license.message : '',
  }
}

/**
 * Authenticate the native HTTP client through the Web application's launch URL.
 * @param authenticatedUrl - URL supplied by the running Desktop Host.
 * @param send - Electron session fetch, retaining the Web authentication cookie.
 * @returns metadata reads and write-only credential operations over standard RPC.
 */
export async function connectDesktopWelcome(
  authenticatedUrl: string,
  send: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<DesktopWelcomeBackend> {
  const origin = new URL(authenticatedUrl).origin
  const authenticated = await send(authenticatedUrl, { credentials: 'include' })
  await authenticated.body?.cancel()
  if (!authenticated.ok) throw new Error('desktop welcome: Web authentication failed')
  const invoke = async (
    request: { namespace: string; method: string; args: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const rpcId = randomUUID()
    const method = `${request.namespace}/${request.method}`
    const response = await send(new URL(`/api/${method}`, origin).href, {
      method: 'POST', credentials: 'include', redirect: 'error', ...(signal === undefined ? {} : { signal }),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: request.args } }),
    })
    if (!response.ok) throw new Error('desktop welcome: Web request failed')
    const envelope: unknown = await response.json()
    if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
      || !record(envelope.result) || envelope.result.ok !== true) {
      throw new Error('desktop welcome: Web RPC failed')
    }
    return envelope.result.value
  }
  const relayCommand = async (method: string, args: Record<string, unknown> = {}): Promise<unknown> => invoke({ namespace: 'relay', method, args })
  const relay: DesktopRelayBackend = {
    async state() { return relayState(await relayCommand('getState')) },
    async start() {
      const result = await relayCommand('startSignIn')
      const state = relayState(await relayCommand('getState'))
      if (record(result) && result.ok === false) return { ...state, signIn: { phase: 'failed', error: errorOf(result.code) } }
      return state
    },
    async cancel() {
      await relayCommand('cancelSignIn')
      return relayState(await relayCommand('getState'))
    },
    async activate(cardKey) {
      const outcome = await relayCommand('activate', { cardKey })
      if (!record(outcome) || typeof outcome.ok !== 'boolean' || typeof outcome.message !== 'string') throw new Error('desktop welcome: invalid activation outcome')
      return { ok: outcome.ok, message: outcome.message }
    },
    async signOut() {
      await relayCommand('logout')
      return relayState(await relayCommand('getState'))
    },
  }
  const localePreference = (namespaces: unknown[]): string | null => {
    const locale: unknown = namespaces.find((item: unknown) => record(item) && item.ns === 'locale')
    if (!record(locale) || !record(locale.value)
      || (locale.value.preference !== undefined && typeof locale.value.preference !== 'string')) {
      throw new Error('desktop welcome: invalid locale preference')
    }
    return locale.value.preference ?? null
  }
  const describeSettings = async (): Promise<unknown[]> => {
    const settings = await invoke({ namespace: 'settings', method: 'describe', args: {} })
    if (!record(settings) || !Array.isArray(settings.namespaces)) throw new Error('desktop welcome: missing settings namespaces')
    return settings.namespaces
  }
  return {
    relay,
    async read() {
      const [state, namespaces] = await Promise.all([relay.state(), describeSettings()])
      return { relayReady: state.signedIn, localePreference: localePreference(namespaces) }
    },
    async checkUpdate() { return parseRelayUpdate(await relayCommand('checkUpdate')) },
    async analyticsEnabled() {
      const enabled = await invoke({ namespace: 'productAnalytics', method: 'enabled', args: {} }, AbortSignal.timeout(1000))
      if (typeof enabled !== 'boolean') throw new Error('desktop analytics: invalid collection policy')
      return enabled
    },
    async report(event) { await invoke({ namespace: 'productAnalytics', method: 'report', args: { event } }, AbortSignal.timeout(1000)) },
    async readLocalePreference() { return localePreference(await describeSettings()) },
  }
}
