/** Native welcome reuses authenticated Web RPC for relay sign-in and card activation; it never reads tokens. */
import { describe, expect, it, vi } from 'vitest'
import { connectDesktopWelcome } from '../src/welcome-backend.ts'

interface RelayFixture {
  account: Record<string, unknown>
  license: Record<string, unknown> | null
  startResult: Record<string, unknown>
  activateResult: Record<string, unknown>
}

function transport(preference?: string) {
  const relay: RelayFixture = {
    account: { status: 'signed-out', profile: null, signIn: { phase: 'idle' } },
    license: null,
    startResult: { ok: true },
    activateResult: { ok: true, message: 'ok' },
  }
  const namespaces = [{ ns: 'locale', value: preference === undefined ? {} : { preference } }]
  const send = vi.fn<Parameters<typeof connectDesktopWelcome>[1]>(async (_input, init) => {
    if (init?.method !== 'POST') return new Response('index')
    const { rpcId, method } = JSON.parse(init.body as string) as { rpcId: string; method: string }
    let value: unknown
    if (method === 'relay/getState') value = { account: relay.account, license: relay.license, configured: true }
    else if (method === 'relay/startSignIn') value = relay.startResult
    else if (method === 'relay/cancelSignIn') value = undefined
    else if (method === 'relay/activate') value = relay.activateResult
    else if (method === 'relay/logout') relay.account = { status: 'signed-out', profile: null, signIn: { phase: 'idle' } }
    else if (method === 'settings/describe') value = { namespaces }
    else if (method === 'productAnalytics/enabled') value = true
    return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } })
  })
  return { send, relay }
}

const url = 'http://127.0.0.1:19387/?token=fixture'
const signedIn = { status: 'signed-in', profile: { id: 1, email: 'a@b.co' }, signIn: { phase: 'idle' } }

describe('desktop welcome Web operations', () => {
  it('authenticates through Web and sends every call with credentials and no redirects', async () => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    expect(host.send).toHaveBeenCalledExactlyOnceWith(url, { credentials: 'include' })
    expect(await backend.analyticsEnabled()).toBe(true)
    await backend.relay.state()
    for (const [input, init] of host.send.mock.calls.slice(1)) {
      expect(input).toMatch(/^http:\/\/127\.0\.0\.1:19387\/api\//u)
      expect(init).toMatchObject({ credentials: 'include', redirect: 'error' })
    }
  })

  it('is ready as soon as the account is signed in, with or without an activation card', async () => {
    const host = transport('zh')
    const backend = await connectDesktopWelcome(url, host.send)
    expect(await backend.read()).toEqual({ relayReady: false, localePreference: 'zh' })
    host.relay.account = signedIn
    expect((await backend.read()).relayReady).toBe(true)
    host.relay.license = { valid: false, message: 'expired' }
    expect((await backend.read()).relayReady).toBe(true)
  })

  it('maps the account and card into the safe welcome state', async () => {
    const host = transport()
    host.relay.account = { ...signedIn, signIn: { phase: 'waiting-browser', authorizeUrl: 'http://site/authorize' } }
    host.relay.license = { valid: false, message: 'card expired' }
    const backend = await connectDesktopWelcome(url, host.send)
    expect(await backend.relay.state()).toEqual({
      configured: true, signedIn: true, email: 'a@b.co', licensed: false, licenseMessage: 'card expired',
      signIn: { phase: 'waiting-browser', authorizeUrl: 'http://site/authorize' },
    })
  })

  it('shows a refused sign-in start as a failed attempt with a localized class', async () => {
    const host = transport()
    host.relay.startResult = { ok: false, code: 'not-configured' }
    const backend = await connectDesktopWelcome(url, host.send)
    expect((await backend.relay.start()).signIn).toEqual({ phase: 'failed', error: 'not-configured' })
    host.relay.startResult = { ok: false, code: 'whatever' }
    expect((await backend.relay.start()).signIn).toEqual({ phase: 'failed', error: 'failed' })
  })

  it('passes the card key to activation and returns only the backend message', async () => {
    const host = transport()
    host.relay.activateResult = { ok: false, message: 'bad card', token: 'must-not-leak' }
    const backend = await connectDesktopWelcome(url, host.send)
    expect(await backend.relay.activate('ABCD-EFGH')).toEqual({ ok: false, message: 'bad card' })
    const call = host.send.mock.calls.find(([input]) => String(input).endsWith('/api/relay/activate'))!
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({ payload: { args: { cardKey: 'ABCD-EFGH' } } })
  })

  it('signs out and returns the settled state', async () => {
    const host = transport()
    host.relay.account = signedIn
    const backend = await connectDesktopWelcome(url, host.send)
    expect((await backend.relay.signOut()).signedIn).toBe(false)
  })

  it('reads language without querying the relay', async () => {
    const host = transport('zh')
    const backend = await connectDesktopWelcome(url, host.send)
    host.send.mockClear()
    expect(await backend.readLocalePreference()).toBe('zh')
    expect(host.send).toHaveBeenCalledOnce()
    expect(host.send.mock.calls[0]![0]).toContain('/api/settings/describe')
  })

  it('rejects an invalid relay state and unmatched RPC envelopes', async () => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    host.send.mockResolvedValueOnce(Response.json({ type: 'server-response', rpcId: 'other', result: { ok: true } }))
    await expect(backend.relay.state()).rejects.toThrow('Web RPC failed')
    host.relay.account = undefined as never
    await expect(backend.relay.state()).rejects.toThrow('invalid relay state')
  })

  it('submits native analytics through authenticated RPC with a bounded request', async () => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    const event = { eventName: 'desktop_app_launch' as const, timestamp: 100, attributes: {} }
    await backend.report(event)
    const [input, init] = host.send.mock.calls.at(-1)!
    expect(input).toBe('http://127.0.0.1:19387/api/productAnalytics/report')
    expect(init?.credentials).toBe('include')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init!.body as string)).toMatchObject({ payload: { args: { event } } })
  })

  it('refuses an unauthenticated Web launch', async () => {
    const send = vi.fn<Parameters<typeof connectDesktopWelcome>[1]>(async () => new Response(null, { status: 401 }))
    await expect(connectDesktopWelcome(url, send)).rejects.toThrow('Web authentication failed')
  })
})
