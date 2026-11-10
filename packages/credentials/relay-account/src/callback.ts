/** One-shot loopback listener that receives the OAuth authorization code from the browser. */
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'

const PAGE = '<!doctype html><meta charset="utf-8"><title>OK</title><body style="font-family:sans-serif;text-align:center;margin-top:20vh">'
  + '<p>登录成功，可以关闭此页面并返回软件。 / Signed in. You can close this tab and return to the app.</p>'

/** Listener handle returned by {@link openCallback}. */
export interface CallbackListener {
  /** `http://127.0.0.1:<port>/callback`, the redirect URI registered for this attempt. */
  readonly redirectUri: string
  /** Resolves with the authorization code; rejects when `signal` aborts. */
  readonly code: Promise<string>
  /** Stop listening. */
  close(): void
}

/**
 * Listen on an ephemeral loopback port for exactly one valid callback.
 * @param state - expected `state` query value; other requests get 400.
 * @param signal - attempt lifetime; aborting closes the listener and rejects `code`.
 * @returns the redirect URI and the pending code.
 */
export async function openCallback(state: string, signal: AbortSignal): Promise<CallbackListener> {
  const code = Promise.withResolvers<string>()
  void code.promise.catch(() => undefined)
  const expected = Buffer.from(state)
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const received = Buffer.from(url.searchParams.get('state') ?? '')
    const value = url.searchParams.get('code')
    if (req.method !== 'GET' || url.pathname !== '/callback' || value === null || value === ''
      || received.length !== expected.length || !timingSafeEqual(received, expected)) {
      res.writeHead(400, { 'cache-control': 'no-store' }).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE)
    code.resolve(value)
  })
  const close = (): void => { server.close(); server.closeAllConnections() }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const abort = (): void => { code.reject(new Error('aborted')); close() }
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  void code.promise.then(() => { close() }, () => undefined)
  return { redirectUri: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/callback`, code: code.promise, close }
}
