/** Relay license service: card-key activation, heartbeat, balance, redemption and usage. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { promisify } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { RelayAccountError, requestBackend } from '@deepseek-ai/dsh-relay-account'
import type { RelayLicenseOutcome, RelayLicenseView } from './types.ts'

export type { RelayLicenseOutcome, RelayLicenseView } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** License state or balance changed.
     * @mode emit
     */
    'relay-license/changed'(): void
  }
  interface Context {
    relayLicense: RelayLicense
  }
}

const STATE = credentialKey('relay-license', 'default')
const DEVICE = credentialKey('relay-license', 'device')
const NEAR_EXPIRY_MS = 5 * 60_000
const execFileAsync = promisify(execFile)

const state = z.object({
  version: z.literal(1),
  cardKey: z.string(),
  token: z.string(),
  tokenExp: z.string().nullable(),
  cardExp: z.string().nullable(),
  durationDays: z.number(),
  activated: z.boolean(),
  message: z.string(),
  balance: z.number(),
  billingEnabled: z.boolean(),
  currency: z.string(),
  planActive: z.boolean().default(true),
})
type State = z.infer<typeof state>
const device = z.object({ id: z.string().min(1) })

const tokenResponse = z.object({
  ok: z.boolean(),
  token: z.string().default(''),
  token_expires_at: z.string().nullish(),
  card_expires_at: z.string().nullish(),
  duration_days: z.number().default(0),
  message: z.string().default(''),
  balance: z.number().default(0),
  billing_enabled: z.boolean().default(false),
  currency: z.string().default(''),
  card_key: z.string().default(''),
  plan_active: z.boolean().default(true),
})
type TokenResponse = z.infer<typeof tokenResponse>

const BLANK: State = {
  version: 1, cardKey: '', token: '', tokenExp: null, cardExp: null, durationDays: 0, activated: false,
  message: '', balance: 0, billingEnabled: false, currency: '', planActive: false,
}

/** Heartbeat and request deadlines. */
export interface Config {
  /** Run the background heartbeat and balance polling. */
  background?: boolean
  /** Heartbeat period after a success. */
  heartbeatIntervalMs?: number
  /** Heartbeat period after a failure. */
  heartbeatRetryMs?: number
  /** Balance polling period. */
  balanceIntervalMs?: number
  /** Quiet period after one refresh attempt, shared by all concurrent callers. */
  refreshCooldownMs?: number
  /** Deadline per backend request. */
  requestTimeoutMs?: number
}
/** Validated options. */
export const Config = Schema.object({
  background: Schema.boolean().default(true),
  heartbeatIntervalMs: Schema.number().min(1).default(600_000),
  heartbeatRetryMs: Schema.number().min(1).default(120_000),
  balanceIntervalMs: Schema.number().min(1).default(60_000),
  refreshCooldownMs: Schema.number().min(0).default(20_000),
  requestTimeoutMs: Schema.number().min(1).max(120_000).default(10_000),
})

/** Headers material the relay verifies; Host-only. */
export interface LicenseCredentials {
  readonly token: string
  readonly cardKey: string
  readonly deviceId: string
}

/**
 * Mask a card key for display.
 * @param code - full card key.
 * @returns first four and last four characters around `****`; short keys are returned unchanged.
 */
export function maskCardKey(code: string): string {
  return code.length <= 4 ? code : `${code.slice(0, 4)}****${code.slice(-4)}`
}

async function machineId(): Promise<string> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true })
      const line = stdout.split('\n').find(l => l.includes('MachineGuid'))
      return line?.trim().split(/\s+/).pop() ?? ''
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)?.[1] ?? ''
    }
    return (await readFile('/etc/machine-id', 'utf8')).trim()
  } catch {
    return ''
  }
}

/** Card-key license service; lifecycle follows the signed-in relay account. */
export class RelayLicense extends Service {
  static inject = ['credentials', 'relayAccount']
  static Config = Config
  private readonly background: boolean
  private readonly heartbeatInterval: number
  private readonly heartbeatRetry: number
  private readonly balanceInterval: number
  private readonly cooldown: number
  private readonly timeout: number
  private readonly lifetime = new AbortController()
  private inflight: Promise<boolean> | undefined
  private lastAttempt = Number.NEGATIVE_INFINITY
  private lastOk = false

  /** @param ctx - Host context with credentials and relayAccount. @param config - timing options. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'relayLicense')
    const resolved = Config(config)
    this.background = resolved.background
    this.heartbeatInterval = resolved.heartbeatIntervalMs
    this.heartbeatRetry = resolved.heartbeatRetryMs
    this.balanceInterval = resolved.balanceIntervalMs
    this.cooldown = resolved.refreshCooldownMs
    this.timeout = resolved.requestTimeoutMs
    ctx.on('credentials/record-updated', (key) => {
      if (key === STATE) this.changed()
    })
    ctx.on('relay-account/changed', () => { this.changed(); void this.restore() })
    ctx.effect(() => () => { this.lifetime.abort() }, 'relay-license: request lifetime')
    if (this.background) this.startBackground()
  }

  /**
   * Read the stored card-key license.
   * @returns license snapshot without the token or the full card key.
   */
  async getState(): Promise<RelayLicenseView> {
    const [current, deviceId] = [await this.read(), await this.deviceId()]
    const cardExp = current.cardExp
    return {
      activated: current.activated,
      valid: this.isValid(current),
      cardKey: maskCardKey(current.cardKey),
      deviceId,
      deviceName: hostname(),
      cardExpiresAt: cardExp,
      durationDays: current.durationDays,
      billingEnabled: current.billingEnabled,
      balance: current.balance,
      currency: current.currency,
      planActive: current.planActive && (current.cardExp === null || Date.parse(current.cardExp) > Date.now()),
      message: current.message,
    }
  }

  /**
   * Activate a card key for this device; requires a signed-in relay account.
   * @param cardKey - card key, case-insensitive.
   * @returns outcome with the backend message.
   */
  async activate(cardKey: string): Promise<RelayLicenseOutcome> {
    const key = cardKey.trim().toUpperCase()
    if (key === '') return { ok: false, message: 'card key required' }
    const accountToken = await this.ctx.relayAccount.getToken()
    if (accountToken === undefined) return { ok: false, message: 'sign in first' }
    const deviceId = await this.deviceId()
    let response: TokenResponse
    try {
      response = await this.post('/api/license/activate', accountToken, { card_key: key, device_id: deviceId, device_name: hostname() })
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'network' }
    }
    if (!response.ok) {
      await this.patch(() => ({ message: response.message }))
      return { ok: false, message: response.message }
    }
    await this.patch(() => ({ ...this.fromResponse(response), cardKey: key, activated: true, message: response.message }))
    return { ok: true, message: response.message || 'activated' }
  }

  /**
   * Re-adopt a card key the signed-in account already bound to this device, so signing in again needs no card entry.
   * @returns whether a license was restored; any refusal or network failure leaves the state unchanged.
   */
  async restore(): Promise<boolean> {
    if (this.isValid(await this.read())) return false
    const accountToken = await this.ctx.relayAccount.getToken()
    if (accountToken === undefined) return false
    try {
      const response = await this.post('/api/license/restore', accountToken, { device_id: await this.deviceId() })
      if (!response.ok) return false
      await this.patch(() => ({ ...this.fromResponse(response), cardKey: response.card_key, activated: true, message: response.message }))
      return true
    } catch {
      return false
    }
  }

  /**
   * Renew the license token. Network failures and a signed-out account keep the old token; only an explicit backend refusal deactivates.
   * @returns whether the license is valid afterwards.
   */
  async refresh(): Promise<boolean> {
    const current = await this.read()
    if (!current.activated) return false
    const accountToken = await this.ctx.relayAccount.getToken()
    if (accountToken === undefined) return this.isValid(current)
    try {
      const response = await this.post('/api/license/heartbeat', accountToken, { card_key: current.cardKey, device_id: await this.deviceId() })
      if (!response.ok) {
        await this.patch(() => ({ activated: false, token: '', message: response.message }))
        return false
      }
      await this.patch(() => ({ ...this.fromResponse(response), activated: true, message: 'ok' }))
      return true
    } catch (error) {
      await this.patch(() => ({ message: error instanceof Error ? error.message : 'network' }))
      return this.isValid(await this.read())
    }
  }

  /**
   * Material for one relay request: a fresh token plus card key and device id.
   * An expired token renews synchronously; a token within five minutes of expiry renews in the background.
   * @returns credentials, or undefined while not activated.
   */
  async getCredentials(): Promise<LicenseCredentials | undefined> {
    let current = await this.read()
    if (!current.activated) return undefined
    const expiry = current.tokenExp === null ? 0 : Date.parse(current.tokenExp)
    if (current.token === '' || Date.now() >= expiry) {
      if (await this.refreshSerial()) current = await this.read()
    } else if (expiry - Date.now() < NEAR_EXPIRY_MS) {
      void this.refreshSerial()
    }
    if (current.token === '') return undefined
    return { token: current.token, cardKey: current.cardKey, deviceId: await this.deviceId() }
  }

  /** Fetch the latest balance; failures are silent and keep the previous figure. */
  async refreshBalance(): Promise<void> {
    const current = await this.read()
    if (!current.activated || current.token === '') return
    try {
      const out = await this.request('GET', '/api/license/balance', current.token)
      const parsed = tokenResponse.safeParse(out)
      if (parsed.success && parsed.data.ok) {
        await this.patch(() => ({
          balance: parsed.data.balance, billingEnabled: parsed.data.billing_enabled,
          ...(parsed.data.currency === '' ? {} : { currency: parsed.data.currency }),
        }))
      }
    } catch { /* balance is display-only */ }
  }

  /**
   * Redeem a top-up code onto the activated card.
   * @param code - top-up code, case-insensitive.
   * @returns outcome with the backend message.
   */
  async redeem(code: string): Promise<RelayLicenseOutcome> {
    const topup = code.trim().toUpperCase()
    if (topup === '') return { ok: false, message: 'top-up code required' }
    await this.refreshIfNearExpiry()
    const current = await this.read()
    if (!current.activated || current.token === '') return { ok: false, message: 'activate a card key first' }
    try {
      const out = tokenResponse.parse(await this.request('POST', '/api/license/redeem', current.token, { topup_code: topup }))
      if (out.ok) {
        await this.patch(() => ({ balance: out.balance, billingEnabled: out.billing_enabled, ...(out.currency === '' ? {} : { currency: out.currency }) }))
      }
      return { ok: out.ok, message: out.message || (out.ok ? 'redeemed' : 'redeem failed') }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'network' }
    }
  }

  /**
   * Query usage totals, per-day model spend and call details; the backend JSON is returned unchanged.
   * @param days - window in days, clamped to 1..90 (default 30).
   * @param page - 1-based page, minimum 1.
   * @param pageSize - rows per page, clamped to 1..100 (default 20).
   * @returns backend JSON.
   * @throws RelayAccountError `rejected` when not activated, when the backend refuses, or when an old backend has no usage route.
   */
  async usage(days: number = 30, page: number = 1, pageSize: number = 20): Promise<unknown> {
    const query = new URLSearchParams({
      days: String(Math.min(90, Math.max(1, Math.trunc(days) || 30))),
      page: String(Math.max(1, Math.trunc(page) || 1)),
      page_size: String(Math.min(100, Math.max(1, Math.trunc(pageSize) || 20))),
    })
    await this.refreshIfNearExpiry()
    const path = `/api/license/usage?${query.toString()}`
    const run = async () => {
      const current = await this.read()
      if (!current.activated || current.token === '') throw new RelayAccountError('rejected', 'activate a card key first')
      return this.request('GET', path, current.token)
    }
    try {
      try {
        return await run()
      } catch (error) {
        if (!(error instanceof RelayAccountError) || error.code !== 'unauthorized' || !(await this.refreshSerial())) throw error
        return await run()
      }
    } catch (error) {
      if (error instanceof RelayAccountError && error.status === 404 && ['', 'HTTP 404', 'Not Found'].includes(error.message)) {
        throw new RelayAccountError('rejected', 'usage is not supported by this backend', 404)
      }
      throw error
    }
  }

  /** Clear the local license, keeping the device id. */
  async deactivate(): Promise<void> {
    await this.ctx.credentials.modifyRecord(STATE, () => Promise.resolve({ kind: 'grant', payload: BLANK }))
  }

  private changed(): void { this.ctx.emit('relay-license/changed') }

  private isValid(current: State): boolean {
    return current.activated
  }

  private fromResponse(response: TokenResponse): Partial<State> {
    return {
      planActive: response.plan_active,
      token: response.token,
      tokenExp: response.token_expires_at ?? null,
      cardExp: response.card_expires_at ?? null,
      durationDays: response.duration_days,
      balance: response.balance,
      billingEnabled: response.billing_enabled,
      ...(response.currency === '' ? {} : { currency: response.currency }),
    }
  }

  private async read(): Promise<State> {
    const record = await this.ctx.credentials.readRecord(STATE)
    if (record === undefined) return BLANK
    const parsed = record.kind === 'grant' ? state.safeParse(record.payload) : undefined
    if (parsed === undefined || !parsed.success) throw new RelayAccountError('invalid-response', 'stored license is unreadable')
    return parsed.data
  }

  private async patch(change: (current: State) => Partial<State>): Promise<void> {
    await this.ctx.credentials.modifyRecord(STATE, (record) => {
      const parsed = record?.kind === 'grant' ? state.safeParse(record.payload) : undefined
      const current = parsed?.success ? parsed.data : BLANK
      return Promise.resolve({ kind: 'grant', payload: { ...current, ...change(current) } })
    })
  }

  private async deviceId(): Promise<string> {
    const record = await this.ctx.credentials.modifyRecord(DEVICE, async (current) => {
      if (current?.kind === 'grant' && device.safeParse(current.payload).success) return undefined
      const seed = `${await machineId() || randomUUID()}|${hostname()}`
      return { kind: 'grant', payload: { id: createHash('sha256').update(seed).digest('hex').slice(0, 32) } }
    })
    return device.parse(record?.kind === 'grant' ? record.payload : undefined).id
  }

  private async request(method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<unknown> {
    return requestBackend({
      origin: this.ctx.relayAccount.getOrigin(), method, path, token, timeoutMs: this.timeout, signal: this.lifetime.signal,
      ...(body === undefined ? {} : { contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify(body)) }),
    })
  }

  private async post(path: string, accountToken: string, body: Record<string, string>): Promise<TokenResponse> {
    const parsed = tokenResponse.safeParse(await this.request('POST', path, accountToken, body))
    if (!parsed.success) throw new RelayAccountError('invalid-response')
    return parsed.data
  }

  private async refreshIfNearExpiry(): Promise<void> {
    const current = await this.read()
    const expiry = current.tokenExp === null ? 0 : Date.parse(current.tokenExp)
    if (this.isValid(current) && expiry - Date.now() < NEAR_EXPIRY_MS) await this.refreshSerial()
  }

  private refreshSerial(): Promise<boolean> {
    if (this.inflight !== undefined) return this.inflight
    if (Date.now() - this.lastAttempt < this.cooldown) return Promise.resolve(this.lastOk)
    this.lastAttempt = Date.now()
    this.inflight = this.refresh().then(
      (ok) => { this.lastOk = ok; return ok },
      () => { this.lastOk = false; return false },
    ).finally(() => { this.inflight = undefined })
    return this.inflight
  }

  private startBackground(): void {
    let heartbeat: NodeJS.Timeout | undefined
    const beat = async () => {
      const current = await this.read().catch(() => BLANK)
      const ok = current.activated ? await this.refreshSerial() : (await this.restore(), true)
      if (!this.lifetime.signal.aborted) heartbeat = setTimeout(() => { void beat() }, ok ? this.heartbeatInterval : this.heartbeatRetry).unref()
    }
    const balance = setInterval(() => { void this.refreshBalance() }, this.balanceInterval).unref()
    heartbeat = setTimeout(() => { void beat() }, 0).unref()
    this.ctx.effect(() => () => {
      clearTimeout(heartbeat)
      clearInterval(balance)
    }, 'relay-license: background timers')
  }
}

export default RelayLicense
