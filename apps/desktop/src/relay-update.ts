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
 * Decode the Host `relay/checkUpdate` result.
 * @param value - Remote value.
 * @returns the published release, or null when none exists or the lookup failed.
 */
export function parseRelayUpdate(value: unknown): RelayUpdate | null {
  if (typeof value !== 'object' || value === null || !('ok' in value) || value.ok !== true || !('update' in value)) return null
  const update = value.update
  if (typeof update !== 'object' || update === null) return null
  const { version, url, sha256, mandatory, note } = update as Record<string, unknown>
  if (typeof version !== 'string' || typeof url !== 'string' || typeof sha256 !== 'string'
    || typeof mandatory !== 'boolean' || typeof note !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(version)) return null
  return { version, url, sha256, mandatory, note }
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
