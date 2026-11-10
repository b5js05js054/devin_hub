/** Relay Remote delegation keeps tokens out of views and reports account failures as values. */
import { Context } from '@deepseek-ai/cordis'
import { RelayAccountError } from '@deepseek-ai/dsh-relay-account'
import type { RelayAccountView } from '@deepseek-ai/dsh-relay-account/types'
import type { RelayLicenseView } from '@deepseek-ai/dsh-relay-license/types'
import { afterEach, expect, it, vi } from 'vitest'
import RelayController from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

const idle = { phase: 'idle', sent: 0, total: 0 } as const
const signedOut: RelayAccountView = { status: 'signed-out', profile: null, expiresAt: null, upload: idle, signIn: { phase: 'idle' }, hasBackground: false }
const signedIn: RelayAccountView = {
  status: 'signed-in', profile: { id: 1, email: 'a@b.co', avatarUrl: null }, expiresAt: '2030-01-01T00:00:00Z', upload: idle, signIn: { phase: 'idle' }, hasBackground: false,
}
const license: RelayLicenseView = {
  activated: true, valid: true, cardKey: 'ABCD****WXYZ', deviceId: 'd', deviceName: 'n', cardExpiresAt: null,
  durationDays: 0, billingEnabled: true, balance: 5, currency: 'CNY', planActive: true, message: '',
}

function fixture(initial: RelayAccountView = signedOut) {
  const ctx = new Context()
  roots.push(ctx)
  let account = initial
  const relayAccount = {
    getState: vi.fn(() => Promise.resolve(account)),
    getOrigin: vi.fn(() => 'https://relay.example'),
    login: vi.fn(() => { account = signedIn; return Promise.resolve(signedIn) }),
    register: vi.fn(() => Promise.resolve(signedIn)),
    refresh: vi.fn(() => Promise.resolve(signedIn)),
    logout: vi.fn(() => { account = signedOut; return Promise.resolve() }),
  }
  const relayLicense = {
    getState: vi.fn(() => Promise.resolve(license)),
    activate: vi.fn(() => Promise.resolve({ ok: true, message: 'ok' })),
    redeem: vi.fn(() => Promise.resolve({ ok: false, message: 'bad code' })),
    refreshBalance: vi.fn(() => Promise.resolve()),
    deactivate: vi.fn(() => Promise.resolve()),
    usage: vi.fn(() => Promise.resolve({})),
  }
  ctx.provide('relayAccount', relayAccount as never)
  ctx.provide('relayLicense', relayLicense as never)
  return { ctx, relayAccount, relayLicense, controller: new RelayController(ctx) }
}

it('hides the license while signed out and shows it once signed in', async () => {
  const { controller, relayLicense } = fixture()
  expect(await controller.getState()).toEqual({ account: signedOut, license: null, configured: true })
  expect(relayLicense.getState).not.toHaveBeenCalled()
  expect(await controller.login('a@b.co', 'secret1')).toEqual({ ok: true })
  expect(await controller.getState()).toEqual({ account: signedIn, license, configured: true })
})

it('returns account failures as values and rethrows unexpected ones', async () => {
  const { controller, relayAccount } = fixture()
  relayAccount.login.mockRejectedValueOnce(new RelayAccountError('rejected', 'wrong password'))
  expect(await controller.login('a@b.co', 'x')).toEqual({ ok: false, code: 'rejected', message: 'wrong password' })
  const failure = new Error('boom')
  relayAccount.login.mockRejectedValueOnce(failure)
  await expect(controller.login('a@b.co', 'x')).rejects.toBe(failure)
})

it('decodes the registration avatar and rejects an oversized one before the service', async () => {
  const { controller, relayAccount } = fixture()
  await controller.register('a@b.co', 'secret1', { filename: 'me.png', base64: Buffer.from([1, 2, 3]).toString('base64') })
  expect(relayAccount.register).toHaveBeenCalledExactlyOnceWith('a@b.co', 'secret1', { filename: 'me.png', bytes: new Uint8Array([1, 2, 3]) })
  const result = await controller.register('a@b.co', 'secret1', { filename: 'big.png', base64: 'A'.repeat(8 * 1024 * 1024) })
  expect(result).toMatchObject({ ok: false, code: 'invalid-image' })
  expect(relayAccount.register).toHaveBeenCalledTimes(1)
})

it('logout clears the license before the session', async () => {
  const { controller, relayAccount, relayLicense } = fixture(signedIn)
  await controller.logout()
  expect(relayLicense.deactivate.mock.invocationCallOrder[0]).toBeLessThan(relayAccount.logout.mock.invocationCallOrder[0]!)
})

it('streams an initial snapshot and one per change, then stops on abort', async () => {
  const { ctx, controller } = fixture()
  const lifetime = new AbortController()
  const iterator = controller.watch(lifetime.signal)[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toMatchObject({ account: { status: 'signed-out' } })
  const next = iterator.next()
  ctx.emit('relay-account/changed')
  expect((await next).value).toMatchObject({ configured: true })
  const done = iterator.next()
  lifetime.abort()
  expect((await done).done).toBe(true)
})

it('projects totals, model rows and every field of one request record', async () => {
  const { controller, relayLicense } = fixture(signedIn)
  relayLicense.usage.mockResolvedValueOnce({
    currency: 'CNY', range: { days: 30 },
    summary: {
      total_cost: 12.5, today_cost: 1, total_requests: 9, today_requests: 2, total_tokens: 900,
      input_tokens: 100, cache_read_tokens: 700, completion_tokens: 100, cache_hit_rate: 0.875,
    },
    chart: { series: [
      { model: 'a', label: 'Model A', total_cost: 1, total_calls: 5, total_tokens: 300 },
      { model: 'b', label: '', total_cost: 11.5, total_calls: 4, total_tokens: 600 },
    ] },
    records: {
      total: 9, page: 2, page_size: 2,
      items: [
        {
          time: '2026-10-30T01:02:03Z', model: 'b', label: 'Model B',
          prompt_tokens: 500, completion_tokens: 75, input_tokens: 100,
          cache_read_tokens: 300, cache_write_tokens: 100,
          cost: 0.00123456789, free: false, estimated: true,
        },
        {
          time: '2026-10-30T00:02:03Z', model: 'a', label: 'Model A',
          prompt_tokens: 0, completion_tokens: 50, input_tokens: 0,
          cache_read_tokens: 0, cache_write_tokens: 0,
          cost: 0, free: true, estimated: false,
        },
      ],
    },
  })
  const result = await controller.usage(30, 2, 2)
  expect(relayLicense.usage).toHaveBeenCalledExactlyOnceWith(30, 2, 2)
  expect(result).toMatchObject({ ok: true, usage: { currency: 'CNY', days: 30, totalCost: 12.5, totalRequests: 9, cacheHitRate: 0.875 } })
  expect(result.ok && result.usage.models.map(m => [m.model, m.label, m.cost])).toEqual([['b', 'b', 11.5], ['a', 'Model A', 1]])
  expect(result.ok && result.usage.records).toEqual({
    total: 9, page: 2, pageSize: 2,
    items: [
      {
        time: '2026-10-30T01:02:03Z', model: 'b', label: 'Model B',
        inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 100,
        outputTokens: 75, totalTokens: 575, cost: 0.00123456789, free: false, estimated: true,
      },
      {
        time: '2026-10-30T00:02:03Z', model: 'a', label: 'Model A',
        inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        outputTokens: 50, totalTokens: 50, cost: 0, free: true, estimated: false,
      },
    ],
  })
})

it('returns usage failures as values', async () => {
  const { controller, relayLicense } = fixture(signedIn)
  relayLicense.usage.mockRejectedValueOnce(new RelayAccountError('rejected', 'activate a card key first'))
  expect(await controller.usage(30)).toEqual({ ok: false, message: 'activate a card key first' })
})
