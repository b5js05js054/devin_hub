/** HTTP protocol of the card-auth backend user API (`/api/user/*`). */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { RelayAccountErrorCode, RelayImageInput } from './types.ts'

/** Error carrying a stable failure class; `message` is the backend's own text when it supplied one. */
export class RelayAccountError extends Error {
  /** @param code - failure class. @param message - human text, defaulting to the code. @param status - HTTP status of a rejected response. */
  constructor(readonly code: RelayAccountErrorCode, message?: string, readonly status?: number) {
    super(message ?? code)
    this.name = 'RelayAccountError'
  }
}

const profileSchema = z.object({
  id: z.number().int(),
  email: z.string(),
  avatar_url: z.string().nullish(),
})

const sessionSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string(),
  user: profileSchema,
})

const meSchema = z.object({ user: profileSchema })

/** Parsed `register`/`login` response. */
export type SessionResponse = z.infer<typeof sessionSchema>

/**
 * Validate the configured backend origin.
 * @param raw - configured URL; empty means unconfigured.
 * @param allowLoopbackHttp - permit plain HTTP on loopback hosts for development.
 * @param allowHttp - permit plain HTTP on any host, for deployments without TLS.
 * @returns the origin without trailing slash, or '' when unconfigured.
 * @throws RelayAccountError `not-configured` for a malformed or insecure origin.
 */
export function backendOrigin(raw: string, allowLoopbackHttp: boolean, allowHttp = false): string {
  const text = raw.trim()
  if (text === '') return ''
  let url: URL
  try { url = new URL(text) } catch { throw new RelayAccountError('not-configured', 'apiOrigin is not a URL') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && (allowHttp || (loopback && allowLoopbackHttp)))
  if (!secure || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new RelayAccountError('not-configured', 'apiOrigin must be an origin without credentials or path, and HTTPS unless HTTP is allowed')
  }
  return url.origin
}

/**
 * Build a multipart/form-data body.
 * @param fields - text fields.
 * @param file - optional file part named `avatar`.
 * @returns encoded bytes and the matching Content-Type.
 */
export function multipartBody(fields: Record<string, string>, file?: RelayImageInput): { body: Uint8Array; contentType: string } {
  const boundary = `----dsh${randomUUID().replaceAll('-', '')}`
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  for (const [name, value] of Object.entries(fields)) {
    parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  if (file !== undefined) {
    const filename = (file.filename.split(/[\\/]/).pop() ?? '').replaceAll(/["\r\n]/g, '') || 'image'
    parts.push(
      encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      file.bytes,
      encoder.encode('\r\n'),
    )
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`))
  const body = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { body.set(part, offset); offset += part.length }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

/**
 * Stream bytes in small chunks so the caller observes upload progress.
 * @param bytes - full request body.
 * @param onSent - called with each chunk's size as the transport pulls it.
 * @returns a one-shot byte stream.
 */
export function countingStream(bytes: Uint8Array, onSent: (n: number) => void): ReadableStream<Uint8Array> {
  const CHUNK = 16 * 1024
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return }
      const chunk = bytes.subarray(offset, offset + CHUNK)
      offset += chunk.length
      onSent(chunk.length)
      controller.enqueue(chunk)
    },
  })
}

/** Request options of {@link requestBackend}. */
export interface BackendRequest {
  origin: string
  method: 'GET' | 'POST'
  path: string
  token?: string
  contentType?: string
  body?: Uint8Array
  /** Receives bytes as they leave; switches the body to a counted stream. */
  onSent?: (n: number) => void
  timeoutMs: number
  signal: AbortSignal
}

/**
 * Send one request and return the parsed JSON body.
 * @param request - target, credentials, body, and deadlines.
 * @returns parsed JSON value of a 2xx response.
 * @throws RelayAccountError `unauthorized` (401 with a token), `rejected` (other non-2xx, with the backend `detail`), `network`, or `invalid-response`.
 */
export async function requestBackend(request: BackendRequest): Promise<unknown> {
  if (request.origin === '') throw new RelayAccountError('not-configured')
  const headers: Record<string, string> = {}
  if (request.contentType !== undefined) headers['content-type'] = request.contentType
  if (request.token !== undefined) headers.authorization = `Bearer ${request.token}`
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'error',
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]),
  }
  if (request.body !== undefined) {
    headers['content-length'] = String(request.body.length)
    if (request.onSent === undefined) {
      init.body = request.body as BodyInit
    } else {
      init.body = countingStream(request.body, request.onSent)
      init.duplex = 'half'
    }
  }
  let response: Response
  try {
    response = await fetch(new URL(request.path, request.origin), init)
  } catch (error) {
    throw new RelayAccountError('network', error instanceof Error ? error.message : undefined)
  }
  const text = await response.text().catch(() => '')
  if (response.status === 401 && request.token !== undefined) throw new RelayAccountError('unauthorized')
  if (!response.ok) throw new RelayAccountError('rejected', detailOf(response.status, text), response.status)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new RelayAccountError('invalid-response')
  }
}

function detailOf(status: number, text: string): string {
  try {
    const detail = (JSON.parse(text) as { detail?: unknown }).detail
    if (typeof detail === 'string' && detail !== '') return detail
    if (Array.isArray(detail)) return 'invalid form'
  } catch { /* fall through to the status text */ }
  return `HTTP ${String(status)}`
}

/**
 * Validate a login or registration response.
 * @param value - parsed JSON.
 * @returns the typed session.
 * @throws RelayAccountError `invalid-response`.
 */
export function parseSession(value: unknown): SessionResponse {
  const parsed = sessionSchema.safeParse(value)
  if (!parsed.success) throw new RelayAccountError('invalid-response')
  return parsed.data
}

/**
 * Validate a `/api/user/me` response.
 * @param value - parsed JSON.
 * @returns the typed profile.
 * @throws RelayAccountError `invalid-response`.
 */
export function parseMe(value: unknown): SessionResponse['user'] {
  const parsed = meSchema.safeParse(value)
  if (!parsed.success) throw new RelayAccountError('invalid-response')
  return parsed.data.user
}
