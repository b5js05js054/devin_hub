// @vitest-environment jsdom
/** Relay account page: browser sign-in, failure copy, and the license panel. */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { RelayAccountSection, type RelayAccountInjected, type RelaySnapshot } from '../src/client/RelayAccountSection.tsx'
import { RelayUsageSection, type RelayUsageInjected } from '../src/client/RelayUsageSection.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const signedOut = { account: { status: 'signed-out', profile: null, expiresAt: null, upload: { phase: 'idle' }, signIn: { phase: 'idle' }, hasBackground: false }, license: null, configured: true }
const license = { activated: true, valid: true, cardKey: 'ABCD****WXYZ', deviceId: 'd', deviceName: 'laptop', cardExpiresAt: null, durationDays: 30, billingEnabled: true, balance: 12.5, currency: 'USD', planActive: true, message: '' }
const signedIn = { ...signedOut, account: { ...signedOut.account, status: 'signed-in', profile: { id: 1, email: 'a@b.co', avatarUrl: null } }, license }

function mount(view: unknown, overrides: Partial<RelayAccountInjected> = {}) {
  const actions = {
    startSignIn: vi.fn(async () => ({ ok: true as const })), cancelSignIn: vi.fn(async () => {}), logout: vi.fn(async () => {}),
    activate: vi.fn(async () => ({ ok: true, message: 'ok' })), redeem: vi.fn(async () => ({ ok: false, message: 'bad code' })),
    refreshBalance: vi.fn(async () => {}), ...overrides,
  }
  const snapshot = { view, failed: false } as RelaySnapshot
  const props = {
    t: (key: keyof typeof en) => en[key], useRelay: (select: (value: RelaySnapshot) => unknown) => select(snapshot), ...actions,
  }
  render(<RelayAccountSection {...(props as unknown as ComponentProps<typeof RelayAccountSection>)} />)
  return actions
}

it('starts browser sign-in and localizes a refused start', async () => {
  const startSignIn = vi.fn(async () => ({ ok: false as const, code: 'network' as const, message: '' }))
  mount(signedOut, { startSignIn })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.browserSignIn })) })
  expect(startSignIn).toHaveBeenCalledOnce()
  expect(screen.getByRole('alert').textContent).toBe(en.errorNetwork)
})

it('offers the sign-in link and cancel while waiting for the browser', async () => {
  const actions = mount({ ...signedOut, account: { ...signedOut.account, signIn: { phase: 'waiting-browser', authorizeUrl: 'http://site/account/authorize?x=1' } } })
  expect(screen.getByRole('link', { name: en.browserOpenLink }).getAttribute('href')).toBe('http://site/account/authorize?x=1')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.browserCancel })) })
  expect(actions.cancelSignIn).toHaveBeenCalledOnce()
})

it('shows the license and balance, activates a card key, and reports a refused top-up', async () => {
  const actions = mount(signedIn)
  expect(screen.getByText('a@b.co')).toBeTruthy()
  expect(screen.getByText(/ABCD\*\*\*\*WXYZ/).textContent).toContain(en.licenseValid)
  expect(screen.getByText('12.50 USD')).toBeTruthy()
  fireEvent.change(screen.getByPlaceholderText(en.cardKeyPlaceholder), { target: { value: ' KEY-1 ' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.activate })) })
  expect(actions.activate).toHaveBeenCalledWith(' KEY-1 ')
  expect(screen.getByRole('status').textContent).toBe(en.activated)
  fireEvent.change(screen.getByPlaceholderText(en.topupPlaceholder), { target: { value: 'TOP' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.redeem })) })
  expect(screen.getByRole('alert').textContent).toBe('bad code')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.signOut })) })
  expect(actions.logout).toHaveBeenCalledOnce()
})

it('explains a missing backend and keeps both dictionaries in sync', () => {
  mount({ ...signedOut, configured: false })
  expect(screen.getByRole('status').textContent).toBe(en.notConfigured)
  expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
})

const usage = {
  currency: 'CNY', days: 30, totalCost: 12.5, todayCost: 1, totalRequests: 9, todayRequests: 2, totalTokens: 1_500_000,
  inputTokens: 100_000, cacheReadTokens: 1_300_000, outputTokens: 100_000, cacheHitRate: 0.875,
  models: [{ model: 'b', label: 'Model B', cost: 11.5, requests: 4, tokens: 600 }, { model: 'a', label: 'Model A', cost: 1, requests: 5, tokens: 300 }],
  records: {
    total: 9, page: 1, pageSize: 2,
    items: [
      {
        time: '2026-10-30T01:02:03Z', model: 'b', label: 'Model B', inputTokens: 100,
        cacheReadTokens: 300, cacheWriteTokens: 100, outputTokens: 75, totalTokens: 575,
        cost: 0.00123456789, free: false, estimated: true,
      },
      {
        time: '2026-10-30T00:02:03Z', model: 'a', label: 'Model A', inputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50, totalTokens: 50,
        cost: 0, free: true, estimated: false,
      },
    ],
  },
}

function mountUsage(loadUsage: RelayUsageInjected['loadUsage']) {
  const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
    Object.entries(params ?? {}).reduce((text: string, [name, value]) => text.replace(`{${name}}`, String(value)), en[key])
  render(<RelayUsageSection {...({ t, loadUsage } as unknown as ComponentProps<typeof RelayUsageSection>)} />)
}

it('shows usage totals and per-model rows, then reloads for another window', async () => {
  const loadUsage = vi.fn(async () => ({ ok: true as const, usage }))
  mountUsage(loadUsage)
  expect(await screen.findByText('12.5000 CNY')).toBeTruthy()
  expect(screen.getAllByText('Model B')).not.toHaveLength(0)
  expect(screen.getByText('1.5M')).toBeTruthy()
  expect(screen.getByText('87.5%')).toBeTruthy()
  expect(loadUsage).toHaveBeenLastCalledWith(30, 1, 20)
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Last 7 days' })) })
  expect(loadUsage).toHaveBeenLastCalledWith(7, 1, 20)
})

it('renders each request with its exact token buckets, cost, free and estimated markers', async () => {
  mountUsage(vi.fn(async () => ({ ok: true as const, usage })))
  expect(await screen.findByText('Estimated')).toBeTruthy()
  const row = screen.getByText('Estimated').closest('tr')!
  expect(row.textContent).toContain('Model B')
  expect(row.textContent).toContain('500 / 100')
  expect(row.textContent).toContain('300 / 100')
  expect(row.textContent).toContain('75')
  expect(row.textContent).toContain('575')
  expect(row.textContent).toContain('0.001235 CNY')
  expect(screen.getAllByText('Free')).toHaveLength(2)
  expect(screen.getAllByText('Free')[0]!.closest('tr')?.textContent).toContain('Model A')
  expect(screen.queryByText('0.000000 CNY')).toBeNull()
  expect(screen.getByText('1–2 / 9')).toBeTruthy()
})

it('requests the selected page and disables unavailable page actions', async () => {
  const loadUsage = vi.fn(async (_days: number, page: number, pageSize: number) => ({
    ok: true as const,
    usage: {
      ...usage,
      records: { ...usage.records, total: 21, page, pageSize, items: page === 2 ? usage.records.items.slice(0, 1) : usage.records.items },
    },
  }))
  mountUsage(loadUsage)
  expect(await screen.findByText('Estimated')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Previous page' })).toHaveProperty('disabled', true)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Next page' })) })
  expect(loadUsage).toHaveBeenLastCalledWith(30, 2, 20)
  expect(await screen.findByText('Page 2 of 2')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Previous page' })).toHaveProperty('disabled', false)
  expect(screen.getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true)
})

it('keeps a paid zero-cost record distinct from a free request', async () => {
  const item = { ...usage.records.items[0]!, cost: 0, free: false }
  mountUsage(vi.fn(async () => ({ ok: true as const, usage: { ...usage, records: { ...usage.records, items: [item] } } })))
  expect(await screen.findByText('0.000000 CNY')).toBeTruthy()
  expect(screen.queryByText('Free')).toBeNull()
})

it('shows an empty range without negative record numbers', async () => {
  mountUsage(vi.fn(async () => ({
    ok: true as const,
    usage: { ...usage, records: { total: 0, page: 1, pageSize: 20, items: [] } },
  })))
  expect(await screen.findByText('0–0 / 0')).toBeTruthy()
})

it('shows the backend message when usage cannot be loaded', async () => {
  mountUsage(vi.fn(async () => ({ ok: false as const, message: 'activate a card key first' })))
  expect((await screen.findByRole('alert')).textContent).toBe('activate a card key first')
})
