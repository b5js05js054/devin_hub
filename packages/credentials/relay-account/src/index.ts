/** Relay account service: email/password session against the card-auth backend, token held as a credential grant. */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { openCallback } from './callback.ts'
import {
  RelayAccountError, backendOrigin, multipartBody, parseMe, parseSession, requestBackend, type SessionResponse,
} from './protocol.ts'
import type {
  RelayAccountProfile, RelayAccountView, RelayBackground, RelayImageInput, RelaySignInView, RelayUpdateInfo, RelayUploadProgress,
} from './types.ts'

export type {
  RelayAccountErrorCode, RelayAccountProfile, RelayAccountView, RelayBackground, RelayImageInput, RelaySignInView, RelayUpdateInfo, RelayUploadPhase, RelayUploadProgress,
} from './types.ts'
export { RelayAccountError, requestBackend } from './protocol.ts'
export type { BackendRequest } from './protocol.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Session, profile, or background changed.
     * @mode emit
     */
    'relay-account/changed'(): void
  }
  interface Context {
    relayAccount: RelayAccount
  }
}

const KEY = credentialKey('relay-account', 'default')
const MAX_BACKGROUND_BYTES = 5 * 1024 * 1024
const MAX_AVATAR_BYTES = 5 * 1024 * 1024
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const grant = z.object({
  version: z.literal(1),
  origin: z.string(),
  token: z.string().min(1),
  expiresAt: z.string(),
  user: z.object({ id: z.number().int(), email: z.string(), avatarUrl: z.string().nullable() }),
})
type Grant = z.infer<typeof grant>

const clientConfigSchema = z.object({
  update: z.object({
    enabled: z.boolean().default(false),
    version: z.string().default(''),
    url: z.string().default(''),
    sha256: z.string().default(''),
    url_macos: z.string().default(''),
    sha256_macos: z.string().default(''),
    mandatory: z.boolean().default(false),
    note: z.string().default(''),
  }).nullish(),
})

/** Deployment options of the relay backend connection. */
export interface Config {
  /** Backend HTTPS origin serving `/api/user/*`; empty leaves the account unconfigured. */
  apiOrigin?: string
  /** Permit plain HTTP on loopback hosts for development. */
  allowLoopbackHttp?: boolean
  /** Permit plain HTTP on any host, for backends served without TLS. */
  allowHttp?: boolean
  /** Deadline for login, profile, and session requests. */
  requestTimeoutMs?: number
  /** Deadline for the registration upload. */
  uploadTimeoutMs?: number
  /** How long a browser sign-in waits for the authorization callback. */
  signInTimeoutMs?: number
}
/** Validated options. */
export const Config = Schema.object({
  apiOrigin: Schema.string().default(''),
  allowLoopbackHttp: Schema.boolean().default(false),
  allowHttp: Schema.boolean().default(false),
  requestTimeoutMs: Schema.number().min(1).max(120_000).default(15_000),
  uploadTimeoutMs: Schema.number().min(1).max(3_600_000).default(300_000),
  signInTimeoutMs: Schema.number().min(1).max(3_600_000).default(600_000),
})

const IDLE: RelayUploadProgress = { phase: 'idle', sent: 0, total: 0 }
const SIGN_IN_IDLE: RelaySignInView = { phase: 'idle' }

/**
 * Sniff an image type from its leading bytes.
 * @param bytes - candidate image content.
 * @returns extension and MIME type, or undefined when the content is not png, jpg, gif, or webp.
 */
export function sniffImage(bytes: Uint8Array): { ext: 'png' | 'jpg' | 'gif' | 'webp'; mime: string } | undefined {
  const at = (i: number) => bytes[i]
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return { ext: 'png', mime: 'image/png' }
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { ext: 'jpg', mime: 'image/jpeg' }
  if (bytes.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return { ext: 'gif', mime: 'image/gif' }
  if (bytes.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
    && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return { ext: 'webp', mime: 'image/webp' }
  return undefined
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const

/**
 * Account service of the relay backend. `getToken` is Host-only: no view returned by this service carries the session token.
 */
export class RelayAccount extends Service {
  static inject = ['credentials']
  static Config = Config
  private readonly origin: string
  private readonly requestTimeout: number
  private readonly uploadTimeout: number
  private readonly backgroundDir: string
  private readonly lifetime = new AbortController()
  private upload: RelayUploadProgress = IDLE
  private signIn: RelaySignInView = SIGN_IN_IDLE
  private signInAbort: AbortController | undefined
  private readonly signInTimeout: number

  /** @param ctx - Host context with credentials. @param config - backend options. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'relayAccount')
    const resolved = Config(config)
    this.origin = backendOrigin(resolved.apiOrigin, resolved.allowLoopbackHttp, resolved.allowHttp)
    this.requestTimeout = resolved.requestTimeoutMs
    this.uploadTimeout = resolved.uploadTimeoutMs
    this.signInTimeout = resolved.signInTimeoutMs
    this.backgroundDir = join(resolveDshHome(), 'relay-account', 'backgrounds')
    ctx.on('credentials/record-updated', (key) => {
      if (key === KEY) this.changed()
    })
    ctx.effect(() => () => { this.lifetime.abort(); this.signInAbort?.abort() }, 'relay-account: request lifetime')
  }

  /** Drop a stored session issued by a different backend origin. */
  async [Service.init](): Promise<void> {
    const record = await this.ctx.credentials.readRecord(KEY)
    if (record === undefined) return
    const stored = this.parse(record)
    if (stored === undefined || stored.origin !== this.origin) await this.ctx.credentials.deleteRecord(KEY)
  }

  /**
   * Read the stored sign-in session.
   * @returns session snapshot without the token.
   */
  async getState(): Promise<RelayAccountView> {
    const stored = await this.readGrant()
    if (stored === undefined) {
      return { status: 'signed-out', profile: null, expiresAt: null, upload: this.upload, signIn: this.signIn, hasBackground: false }
    }
    return {
      status: 'signed-in',
      profile: this.profileOf(stored),
      expiresAt: stored.expiresAt,
      upload: this.upload,
      signIn: this.signIn,
      hasBackground: (await this.backgroundFile(stored.user.id)) !== undefined,
    }
  }

  /**
   * Host-only session token for relay and license requests.
   * @returns the bearer token, or undefined while signed out or expired.
   */
  async getToken(): Promise<string | undefined> {
    const stored = await this.readGrant()
    if (stored === undefined || Date.parse(stored.expiresAt) <= Date.now()) return undefined
    return stored.token
  }

  /**
   * Read the configured relay backend origin.
   * @returns the configured backend origin; '' while unconfigured. Host-only.
   */
  getOrigin(): string { return this.origin }

  /**
   * Read the release the operator published for this platform.
   * @returns the release, or null when none is enabled or none exists for this platform.
   * @throws RelayAccountError `signed-out` without a session; `network`, `rejected`, or `invalid-response` from the backend.
   */
  async checkUpdate(): Promise<RelayUpdateInfo | null> {
    const token = await this.getToken()
    if (token === undefined) throw new RelayAccountError('signed-out')
    const parsed = clientConfigSchema.safeParse(await requestBackend({
      origin: this.origin, method: 'GET', path: '/api/license/client-config', token,
      timeoutMs: this.requestTimeout, signal: this.lifetime.signal,
    }))
    if (!parsed.success) throw new RelayAccountError('invalid-response')
    const update = parsed.data.update
    if (update === null || update === undefined || !update.enabled || update.version === '') return null
    const mac = process.platform === 'darwin'
    const url = mac ? update.url_macos : update.url
    if (url === '') return null
    return { version: update.version, url, sha256: (mac ? update.sha256_macos : update.sha256).toLowerCase(), mandatory: update.mandatory, note: update.note }
  }

  /**
   * Sign in with email and password.
   * @param email - account email.
   * @param password - account password.
   * @returns the new snapshot.
   * @throws RelayAccountError on network, rejection, or malformed response.
   */
  async login(email: string, password: string): Promise<RelayAccountView> {
    const body = new TextEncoder().encode(JSON.stringify({ email: email.trim(), password }))
    const json = await requestBackend({
      origin: this.origin, method: 'POST', path: '/api/user/login', contentType: 'application/json',
      body, timeoutMs: this.requestTimeout, signal: this.lifetime.signal,
    })
    await this.commit(parseSession(json))
    return this.getState()
  }

  /**
   * Register and sign in; upload progress is observable through `getState().upload`.
   * @param email - account email.
   * @param password - account password.
   * @param avatar - optional avatar image, png/jpg/gif/webp up to 5 MB.
   * @returns the new snapshot.
   * @throws RelayAccountError `invalid-image` for an unsupported or oversized avatar, otherwise as {@link login}.
   */
  async register(email: string, password: string, avatar?: RelayImageInput): Promise<RelayAccountView> {
    if (!EMAIL.test(email.trim())) throw new RelayAccountError('rejected', 'invalid email')
    if (avatar !== undefined && (avatar.bytes.length > MAX_AVATAR_BYTES || sniffImage(avatar.bytes) === undefined)) {
      throw new RelayAccountError('invalid-image')
    }
    const { body, contentType } = multipartBody({ email: email.trim(), password }, avatar)
    this.setUpload({ phase: 'uploading', sent: 0, total: body.length })
    try {
      const json = await requestBackend({
        origin: this.origin, method: 'POST', path: '/api/user/register', contentType, body,
        onSent: (n) => {
          const sent = this.upload.sent + n
          this.setUpload({ phase: sent >= body.length ? 'processing' : 'uploading', sent, total: body.length })
        },
        timeoutMs: this.uploadTimeout, signal: this.lifetime.signal,
      })
      await this.commit(parseSession(json))
      this.setUpload({ phase: 'done', sent: body.length, total: body.length })
    } catch (error) {
      const code = error instanceof RelayAccountError ? error.code : 'network'
      this.setUpload({ ...this.upload, phase: 'error', code })
      throw error
    }
    return this.getState()
  }

  /**
   * Begin browser authorization (OAuth code + PKCE) against the website; returns immediately.
   * Progress and the page to open are observable through `getState().signIn`; success stores the session.
   * @returns the snapshot, with `signIn.authorizeUrl` set; an already-running attempt is joined.
   * @throws RelayAccountError `not-configured` without a backend origin.
   */
  async startSignIn(): Promise<RelayAccountView> {
    if (this.origin === '') throw new RelayAccountError('not-configured')
    if (this.signInAbort !== undefined) return this.getState()
    const abort = new AbortController()
    this.signInAbort = abort
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(24).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const timer = setTimeout(() => { abort.abort() }, this.signInTimeout)
    try {
      const listener = await openCallback(state, abort.signal)
      const authorize = new URL('/account', this.origin)
      authorize.search = new URLSearchParams({ code_challenge: challenge, redirect_uri: listener.redirectUri, state }).toString()
      this.setSignIn({ phase: 'waiting-browser', authorizeUrl: authorize.href })
      void this.finishSignIn(listener.code, verifier, listener.redirectUri, abort, timer)
    } catch (error) {
      clearTimeout(timer)
      this.signInAbort = undefined
      this.setSignIn({ phase: 'failed', code: 'network' })
      throw error
    }
    return this.getState()
  }

  /** Abandon a running browser sign-in; idle is a no-op. */
  cancelSignIn(): void { this.signInAbort?.abort() }

  private async finishSignIn(code: Promise<string>, verifier: string, redirectUri: string, abort: AbortController, timer: NodeJS.Timeout): Promise<void> {
    try {
      const received = await code
      this.setSignIn({ phase: 'exchanging' })
      const json = await requestBackend({
        origin: this.origin, method: 'POST', path: '/api/user/oauth/token', contentType: 'application/json',
        body: new TextEncoder().encode(JSON.stringify({ code: received, code_verifier: verifier, redirect_uri: redirectUri })),
        timeoutMs: this.requestTimeout, signal: AbortSignal.any([this.lifetime.signal, abort.signal]),
      })
      await this.commit(parseSession(json))
      this.setSignIn(SIGN_IN_IDLE)
    } catch (error) {
      if (abort.signal.aborted) this.setSignIn(SIGN_IN_IDLE)
      else this.setSignIn({ phase: 'failed', code: error instanceof RelayAccountError ? error.code : 'network' })
    } finally {
      clearTimeout(timer)
      this.signInAbort = undefined
    }
  }

  private setSignIn(next: RelaySignInView): void {
    this.signIn = next
    this.changed()
  }

  /**
   * Re-validate the stored session against the backend; an unauthorized answer signs out locally.
   * @returns the refreshed snapshot.
   * @throws RelayAccountError `signed-out` without a session; `network` keeps the session.
   */
  async refresh(): Promise<RelayAccountView> {
    const stored = await this.readGrant()
    if (stored === undefined) throw new RelayAccountError('signed-out')
    try {
      const user = parseMe(await requestBackend({
        origin: this.origin, method: 'GET', path: '/api/user/me', token: stored.token,
        timeoutMs: this.requestTimeout, signal: this.lifetime.signal,
      }))
      await this.ctx.credentials.modifyRecord(KEY, (current) => {
        const latest = current === undefined ? undefined : this.parse(current)
        if (latest?.token !== stored.token) return Promise.resolve(undefined)
        return Promise.resolve({ kind: 'grant', payload: { ...latest, user: this.userOf(user) } })
      })
    } catch (error) {
      if (error instanceof RelayAccountError && error.code === 'unauthorized') await this.logout()
      else throw error
    }
    return this.getState()
  }

  /** Remove the local session and the local background of that user. */
  async logout(): Promise<void> {
    await this.ctx.credentials.deleteRecord(KEY)
    this.setUpload(IDLE)
  }

  /**
   * Store a custom background for the signed-in user.
   * @param bytes - image content, png/jpg/gif/webp up to 5 MB.
   * @throws RelayAccountError `signed-out` or `invalid-image`.
   */
  async setBackground(bytes: Uint8Array): Promise<void> {
    const stored = await this.readGrant()
    if (stored === undefined) throw new RelayAccountError('signed-out')
    const kind = sniffImage(bytes)
    if (bytes.length > MAX_BACKGROUND_BYTES || kind === undefined) throw new RelayAccountError('invalid-image')
    await this.removeBackgrounds(stored.user.id)
    try {
      await writeFileAtomic(join(this.backgroundDir, `user-${String(stored.user.id)}.${kind.ext}`), bytes, { mode: 0o600, dirMode: 0o700 })
    } catch {
      throw new RelayAccountError('storage')
    }
    this.changed()
  }

  /** Remove the signed-in user's custom background; absent is a no-op. */
  async clearBackground(): Promise<void> {
    const stored = await this.readGrant()
    if (stored === undefined) throw new RelayAccountError('signed-out')
    await this.removeBackgrounds(stored.user.id)
    this.changed()
  }

  /**
   * Read the signed-in user's stored background image.
   * @returns the background image, or undefined when none is stored.
   */
  async readBackground(): Promise<RelayBackground | undefined> {
    const stored = await this.readGrant()
    if (stored === undefined) return undefined
    const file = await this.backgroundFile(stored.user.id)
    if (file === undefined) return undefined
    const ext = file.slice(file.lastIndexOf('.') + 1) as keyof typeof MIME
    return { mime: MIME[ext], bytes: await readFile(join(this.backgroundDir, file)) }
  }

  private changed(): void { this.ctx.emit('relay-account/changed') }

  private setUpload(next: RelayUploadProgress): void {
    this.upload = next
    this.changed()
  }

  private parse(record: { kind: string; payload?: unknown }): Grant | undefined {
    if (record.kind !== 'grant') return undefined
    const parsed = grant.safeParse(record.payload)
    return parsed.success ? parsed.data : undefined
  }

  private async readGrant(): Promise<Grant | undefined> {
    const record = await this.ctx.credentials.readRecord(KEY)
    if (record === undefined) return undefined
    const stored = this.parse(record)
    if (stored === undefined) throw new RelayAccountError('storage')
    return stored
  }

  private userOf(user: SessionResponse['user']): Grant['user'] {
    return { id: user.id, email: user.email, avatarUrl: user.avatar_url ? new URL(user.avatar_url, this.origin).href : null }
  }

  private profileOf(stored: Grant): RelayAccountProfile {
    return { id: stored.user.id, email: stored.user.email, avatarUrl: stored.user.avatarUrl }
  }

  private async commit(session: SessionResponse): Promise<void> {
    const payload: Grant = {
      version: 1, origin: this.origin, token: session.token, expiresAt: session.expires_at, user: this.userOf(session.user),
    }
    await this.ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload }))
  }

  private async backgroundFile(id: number): Promise<string | undefined> {
    const names = await readdir(this.backgroundDir).catch(() => [] as string[])
    return names.find(name => new RegExp(`^user-${String(id)}\\.(png|jpg|gif|webp)$`).test(name))
  }

  private async removeBackgrounds(id: number): Promise<void> {
    await mkdir(this.backgroundDir, { recursive: true, mode: 0o700 })
    for (let file = await this.backgroundFile(id); file !== undefined; file = await this.backgroundFile(id)) {
      await rm(join(this.backgroundDir, file))
    }
  }
}

export default RelayAccount
