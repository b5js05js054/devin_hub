/** Download, verify, and launch the client package the card-auth backend publishes. */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Release published by the backend for this platform. */
export interface RelayUpdate {
  readonly version: string
  readonly url: string
  /** Lowercase hex SHA-256; empty when the operator published none. */
  readonly sha256: string
  readonly mandatory: boolean
  readonly note: string
}

/**
 * Answer of one release lookup. A failure stays distinct from "no release published", so a
 * user-requested check never reports "up to date" for a backend it could not ask.
 */
export type RelayUpdateLookup =
  | { readonly ok: true; readonly update: RelayUpdate | null }
  /** `code` is the Host failure class (`signed-out`, `network`, …), or `invalid-response` for an undecodable answer. */
  | { readonly ok: false; readonly code: string; readonly message: string }

/**
 * Decode the Host `relay/checkUpdate` result.
 * @param value - Remote value.
 * @returns the published release, none, or the failure class; an undecodable value is a failure.
 */
export function parseRelayUpdateLookup(value: unknown): RelayUpdateLookup {
  const invalid: RelayUpdateLookup = { ok: false, code: 'invalid-response', message: '' }
  if (typeof value !== 'object' || value === null || !('ok' in value)) return invalid
  if (value.ok === false) {
    const { code, message } = value as { code?: unknown; message?: unknown }
    return typeof code === 'string' && code !== '' && typeof message === 'string' ? { ok: false, code, message } : invalid
  }
  if (value.ok !== true || !('update' in value)) return invalid
  const update = value.update
  if (update === null) return { ok: true, update: null }
  if (typeof update !== 'object') return invalid
  const { version, url, sha256, mandatory, note } = update as Record<string, unknown>
  if (typeof version !== 'string' || typeof url !== 'string' || typeof sha256 !== 'string'
    || typeof mandatory !== 'boolean' || typeof note !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(version)) return invalid
  return { ok: true, update: { version, url, sha256, mandatory, note } }
}

/**
 * Compare dotted numeric versions of up to four parts.
 * @param candidate - published version.
 * @param installed - running version; a prerelease suffix is ignored.
 * @returns whether the candidate is strictly newer.
 */
export function isNewerRelease(candidate: string, installed: string): boolean {
  const parts = (text: string): number[] => text.split(/[-+]/)[0]!.split('.').map(part => Number.parseInt(part, 10) || 0)
  const [a, b] = [parts(candidate), parts(installed)]
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0]
    if (x !== y) return x > y
  }
  return false
}

/**
 * Download a release into a fresh temporary directory and verify its checksum.
 * @param update - published release.
 * @param send - Electron session fetch.
 * @param onProgress - percentage 0..100 when the server reports a length.
 * @param signal - cancellation.
 * @returns absolute path of the verified package.
 * @throws Error on a failed transfer or a checksum mismatch; the partial file is left in the temporary directory.
 */
export async function downloadRelayUpdate(
  update: RelayUpdate,
  send: (input: string, init?: RequestInit) => Promise<Response>,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const response = await send(update.url, { redirect: 'follow', ...signal === undefined ? {} : { signal } })
  if (!response.ok || response.body === null) throw new Error(`desktop update: download failed (HTTP ${String(response.status)})`)
  const total = Number(response.headers.get('content-length') ?? 0)
  const name = basename(new URL(update.url).pathname).replaceAll(/[^\w.-]/g, '_') || `update-${update.version}.exe`
  const file = join(await mkdtemp(join(tmpdir(), 'dsh-update-')), name)
  const hash = createHash('sha256')
  let received = 0
  const body = Readable.fromWeb(response.body as never)
  body.on('data', (chunk: Buffer) => {
    hash.update(chunk)
    received += chunk.length
    if (total > 0) onProgress(Math.min(100, (received / total) * 100))
  })
  await pipeline(body, createWriteStream(file, { mode: 0o600 }), ...signal === undefined ? [] : [{ signal }])
  if (update.sha256 !== '' && hash.digest('hex') !== update.sha256) throw new Error('desktop update: package checksum mismatch')
  return file
}
