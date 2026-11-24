/** One-shot loopback listener for the browser's OAuth authorization code. */
import { createServer, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'

const PRIVATE_HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }
const FAILURE = '未能完成桌面登录。请返回客户端重试。 / Sign-in did not complete. Return to the app and try again.'

/** Listener handle returned by {@link openCallback}. */
export interface CallbackListener {
  /** `http://127.0.0.1:<port>/callback`, the redirect URI registered for this attempt. */
  readonly redirectUri: string
  /** Resolves with the first valid authorization code and rejects on cancellation. */
  readonly code: Promise<string>
  /** @param accountCenterUrl - browser destination after saving the grant. Omit on failure. */
  finish(accountCenterUrl?: string): void
}

/**
 * Listen on an ephemeral loopback port for exactly one valid callback.
 * @param state - expected `state` query value. Other requests get 400.
 * @param signal - attempt lifetime. Cancellation rejects an unclaimed callback. After a claim the exchange owns its response.
 * @returns the redirect URI, pending code, and browser response completion.
 */
export async function openCallback(state: string, signal: AbortSignal): Promise<CallbackListener> {
  const code = Promise.withResolvers<string>()
  void code.promise.catch(() => undefined)
  const expected = Buffer.from(state)
  let browser: ServerResponse | undefined
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const received = Buffer.from(url.searchParams.get('state') ?? '')
    const value = url.searchParams.get('code')
    if (browser !== undefined || req.method !== 'GET' || url.pathname !== '/callback' || value === null || value === ''
      || received.length !== expected.length || !timingSafeEqual(received, expected)) {
      res.writeHead(400, PRIVATE_HEADERS).end()
      return
    }
    browser = res
    code.resolve(value)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const redirectUri = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/callback`
  const finish = (accountCenterUrl?: string): void => {
    signal.removeEventListener('abort', abort)
    if (!server.listening) return
    server.close()
    if (browser === undefined) { server.closeAllConnections(); return }
    const stop = () => { server.closeAllConnections() }
    browser.once('close', stop)
    if (browser.destroyed) { stop(); return }
    if (accountCenterUrl === undefined) {
      browser.writeHead(400, { ...PRIVATE_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end(FAILURE)
    } else {
      browser.writeHead(303, { ...PRIVATE_HEADERS, location: accountCenterUrl }).end()
    }
  }
  const abort = (): void => {
    if (browser !== undefined) return
    code.reject(new Error('aborted'))
    finish()
  }
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  return { redirectUri, code: code.promise, finish }
}
