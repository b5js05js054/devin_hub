/** Authenticated Remote operations for the relay account and license page. */
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { RelayAccountError } from '@deepseek-ai/dsh-relay-account'
import type {} from '@deepseek-ai/dsh-relay-license'
import type { RelayAccountView, RelayAvatarUpload, RelayCommandResult, RelayLicenseOutcome, RelayUpdateResult, RelayUsage, RelayUsageModel, RelayUsageRecord, RelayUsageResult, RelayView } from './types.ts'

const MAX_AVATAR_BASE64 = Math.ceil((5 * 1024 * 1024 * 4) / 3) + 8

type Json = Readonly<Record<string, unknown>>
const obj = (value: unknown): Json => (typeof value === 'object' && value !== null ? value as Json : {})
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** @param body - backend usage JSON. @returns totals, costliest model rows first, and the requested record page. */
function projectUsage(body: unknown): RelayUsage {
  const root = obj(body)
  const summary = obj(root.summary)
  const series = Array.isArray(obj(root.chart).series) ? obj(root.chart).series as unknown[] : []
  const models: RelayUsageModel[] = series.map((entry) => {
    const row = obj(entry)
    return {
      model: str(row.model), label: str(row.label) || str(row.model),
      cost: num(row.total_cost), requests: num(row.total_calls), tokens: num(row.total_tokens),
    }
  }).sort((a, b) => b.cost - a.cost || b.requests - a.requests)
  const page = obj(root.records)
  const items: RelayUsageRecord[] = (Array.isArray(page.items) ? page.items : []).map((entry) => {
    const row = obj(entry)
    return {
      time: str(row.time), model: str(row.model), label: str(row.label) || str(row.model),
      inputTokens: num(row.input_tokens), cacheReadTokens: num(row.cache_read_tokens),
      cacheWriteTokens: num(row.cache_write_tokens), outputTokens: num(row.completion_tokens),
      totalTokens: num(row.prompt_tokens) + num(row.completion_tokens),
      cost: num(row.cost), free: row.free === true, estimated: row.estimated === true,
    }
  })
  return {
    currency: str(root.currency), days: num(obj(root.range).days),
    totalCost: num(summary.total_cost), todayCost: num(summary.today_cost),
    totalRequests: num(summary.total_requests), todayRequests: num(summary.today_requests),
    totalTokens: num(summary.total_tokens), inputTokens: num(summary.input_tokens),
    cacheReadTokens: num(summary.cache_read_tokens), outputTokens: num(summary.completion_tokens),
    cacheHitRate: num(summary.cache_hit_rate), models,
    records: { total: num(page.total), page: num(page.page), pageSize: num(page.page_size), items },
  }
}

/** Relay account commands, license actions, and a reconnect-safe state stream. */
export class RelayController extends TypertRemoteService {
  static inject = ['relayAccount', 'relayLicense']
  /** @param ctx - Host with the relay account and license services mounted. */
  constructor(ctx: Context) { super(ctx, 'relayController', { namespace: 'relay' }) }

  /**
   * Read the current account and license snapshot.
   * @returns the combined view; never carries a token.
   */
  @Remote
  async getState(): Promise<RelayView> {
    const account: RelayAccountView = await this.ctx.relayAccount.getState()
    const configured = this.ctx.relayAccount.getOrigin() !== ''
    return { account, license: account.status === 'signed-in' ? await this.ctx.relayLicense.getState() : null, configured }
  }

  /**
   * Begin browser authorization against the website; the page to open is `account.signIn.authorizeUrl`.
   * @returns success, or the failure class (`not-configured` without a backend origin).
   */
  @Remote
  startSignIn(): Promise<RelayCommandResult> { return this.command(() => this.ctx.relayAccount.startSignIn()) }

  /** Abandon a running browser sign-in. */
  @Remote
  cancelSignIn(): void { this.ctx.relayAccount.cancelSignIn() }

  /**
   * Sign in with email and password.
   * @param email - account email.
   * @param password - account password.
   * @returns success, or the failure class with the backend message.
   */
  @Remote
  login(email: string, password: string): Promise<RelayCommandResult> {
    return this.command(() => this.ctx.relayAccount.login(email, password))
  }

  /**
   * Register and sign in.
   * @param email - account email.
   * @param password - account password.
   * @param avatar - optional avatar image, png/jpg/gif/webp up to 5 MB.
   * @returns success, or the failure class with the backend message.
   */
  @Remote
  register(email: string, password: string, avatar?: RelayAvatarUpload): Promise<RelayCommandResult> {
    return this.command(() => {
      if (avatar !== undefined && avatar.base64.length > MAX_AVATAR_BASE64) throw new RelayAccountError('invalid-image')
      const image = avatar === undefined ? undefined : { filename: avatar.filename, bytes: new Uint8Array(Buffer.from(avatar.base64, 'base64')) }
      return this.ctx.relayAccount.register(email, password, image)
    })
  }

  /**
   * Re-validate the stored session against the backend.
   * @returns success or the failure class.
   */
  @Remote
  refresh(): Promise<RelayCommandResult> { return this.command(() => this.ctx.relayAccount.refresh()) }

  /** Remove the local session and license. */
  @Remote
  async logout(): Promise<void> {
    await this.ctx.relayLicense.deactivate()
    await this.ctx.relayAccount.logout()
  }

  /**
   * Bind a card key to this device.
   * @param cardKey - card key to activate.
   * @returns outcome with the backend message.
   */
  @Remote
  activate(cardKey: string): Promise<RelayLicenseOutcome> { return this.ctx.relayLicense.activate(cardKey) }

  /**
   * Redeem a top-up code onto the active card.
   * @param code - top-up code.
   * @returns outcome with the backend message.
   */
  @Remote
  redeem(code: string): Promise<RelayLicenseOutcome> { return this.ctx.relayLicense.redeem(code) }

  /** Re-read the card balance; display-only, never throws. */
  @Remote
  async refreshBalance(): Promise<void> { await this.ctx.relayLicense.refreshBalance() }

  /**
   * Read the card's totals, per-model spend and one newest-first page of request records.
   * @param days - window in days, 1..90.
   * @param page - 1-based request-record page (default 1).
   * @param pageSize - records per page, 1..100 (default 20).
   * @returns the projected usage, or the failure message (not activated, unsupported backend, network).
   */
  @Remote
  async usage(days: number, page?: number, pageSize?: number): Promise<RelayUsageResult> {
    try {
      return { ok: true, usage: projectUsage(await this.ctx.relayLicense.usage(days, page ?? 1, pageSize ?? 20)) }
    } catch (error) {
      if (error instanceof RelayAccountError) return { ok: false, message: error.message }
      throw error
    }
  }

  /**
   * Read the client release the operator published for this platform.
   * @returns the release, null when none is published, or the failure message (signed out, network, backend refusal).
   */
  @Remote
  async checkUpdate(): Promise<RelayUpdateResult> {
    try {
      return { ok: true, update: await this.ctx.relayAccount.checkUpdate() }
    } catch (error) {
      if (error instanceof RelayAccountError) return { ok: false, code: error.code, message: error.message }
      throw error
    }
  }

  /**
   * Stream the combined snapshot: one initial state, then one per account or license change.
   * @param signal - stream lifetime.
   * @returns complete snapshots.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<RelayView> {
    let dirty = true
    let wake: (() => void) | undefined
    const mark = (): void => { dirty = true; wake?.() }
    const stops = [this.ctx.on('relay-account/changed', mark), this.ctx.on('relay-license/changed', mark)]
    const abort = (): void => { wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted) {
        if (dirty) { dirty = false; yield await this.getState(); continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      for (const stop of stops) stop()
      signal.removeEventListener('abort', abort)
    }
  }

  private async command(run: () => Promise<unknown>): Promise<RelayCommandResult> {
    try {
      await run()
      return { ok: true }
    } catch (error) {
      if (error instanceof RelayAccountError) return { ok: false, code: error.code, message: error.message }
      throw error
    }
  }
}
export default RelayController
