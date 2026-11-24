// @vitest-environment jsdom
/** Relay account settings, sidebar launcher and browser links. */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, expect, it, vi } from 'vitest'
import { RelayAccountMenu } from '../src/client/RelayAccountMenu.tsx'
import { RelayAccountSection, type RelayAccountInjected, type RelaySnapshot } from '../src/client/RelayAccountSection.tsx'
import { RelayUsageSection } from '../src/client/RelayUsageSection.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const signedOut: NonNullable<RelaySnapshot['view']> = { account: { status: 'signed-out', profile: null, expiresAt: null, upload: { phase: 'idle', sent: 0, total: 0 }, signIn: { phase: 'idle' }, hasBackground: false }, license: null, configured: true }
const license = { activated: true, valid: true, cardKey: 'ABCD****WXYZ', deviceId: 'd', deviceName: 'laptop', cardExpiresAt: null, durationDays: 30, billingEnabled: true, balance: 12.5, currency: 'USD', planActive: true, planExpiresAt: null, message: '' }
const center = 'http://127.0.0.1:32190/account'
const signedIn: NonNullable<RelaySnapshot['view']> = { ...signedOut, account: { ...signedOut.account, status: 'signed-in', profile: { id: 1, email: 'a@b.co', avatarUrl: null }, accountCenterUrl: center }, license }

const dictionary = new Map(Object.entries(en))
const t: Parameters<typeof RelayAccountSection>[0]['t'] = (key, params) =>
  Object.entries(params ?? {}).reduce<string>((text, [name, value]) => text.replace(`{${name}}`, String(value)), dictionary.get(key) ?? key)

function mount(view: RelaySnapshot['view'], overrides: Partial<Omit<RelayAccountInjected, 'hooks'>> = {}, menu = false) {
  const actions = {
    startSignIn: vi.fn(async () => ({ ok: true as const })), cancelSignIn: vi.fn(async () => {}), logout: vi.fn(async () => {}),
    activate: vi.fn(async () => ({ ok: true, message: 'ok' })), redeem: vi.fn(async () => ({ ok: false, message: 'bad code' })),
    refreshBalance: vi.fn(async () => {}),
    shopCatalog: vi.fn(async () => ({ ok: true as const, catalog: { currency: 'USD', items: [] } })),
    shopBuyWithBalance: vi.fn(async () => ({ ok: true as const, message: 'purchased', order: null })),
    shopBuyWithCard: vi.fn(async () => ({ ok: false as const, message: 'not for this pack', order: null })),
    shopOrders: vi.fn(async () => ({ ok: true as const, orders: [] })),
    ...overrides,
  }
  let snapshot: RelaySnapshot = { view, failed: false }
  const props = { t, useRelay: <U,>(select: (value: RelaySnapshot) => U): U => select(snapshot), ...actions }
  const element = () => menu
    ? <RelayAccountMenu {...unusedSettingsProps} {...props} wide settingsOpen={false} openSettings={vi.fn()} openOnboarding={vi.fn()} />
    : <RelayAccountSection {...unusedSettingsProps} {...props} />
  const rendered = render(element())
  return { ...actions, changeAccount: (view: RelaySnapshot['view']) => { snapshot = { view, failed: false }; rendered.rerender(element()) } }
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
  expect(screen.getByText('ABCD****WXYZ')).toBeTruthy()
  expect(screen.getByText(en.planActive)).toBeTruthy()
  expect(screen.getByText('12.50 USD')).toBeTruthy()
  fireEvent.change(screen.getByPlaceholderText(en.planCodePlaceholder), { target: { value: ' KEY-1 ' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.activate })) })
  expect(actions.activate).toHaveBeenCalledWith(' KEY-1 ')
  expect(screen.getByRole('status').textContent).toBe(en.activated)
  fireEvent.change(screen.getByPlaceholderText(en.topupPlaceholder), { target: { value: 'TOP' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.redeem })) })
  expect(screen.getByRole('alert').textContent).toBe('bad code')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.signOut })) })
  expect(actions.logout).toHaveBeenCalledOnce()
})

it('clears entered activation and top-up codes when the signed-in account changes', () => {
  const page = mount(signedIn)
  fireEvent.change(screen.getByPlaceholderText(en.planCodePlaceholder), { target: { value: 'PRIVATE-PLAN-A' } })
  fireEvent.change(screen.getByPlaceholderText(en.topupPlaceholder), { target: { value: 'PRIVATE-TOPUP-A' } })
  page.changeAccount({ ...signedIn, account: { ...signedIn.account, status: 'signed-in', profile: { id: 2, email: 'b@b.co', avatarUrl: null } } })
  expect(screen.getByPlaceholderText(en.planCodePlaceholder)).toHaveProperty('value', '')
  expect(screen.getByPlaceholderText(en.topupPlaceholder)).toHaveProperty('value', '')
})

it('explains a missing backend and keeps both dictionaries in sync', () => {
  mount({ ...signedOut, configured: false })
  expect(screen.getByRole('status').textContent).toBe(en.notConfigured)
  expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
})

// The focused component fixture does not consume these runtime seats.
const unusedHook = (): never => { throw new Error('unexpected settings hook in relay fixture') }
const unusedSettingsProps: PropsRuntime<'settings.section'> = {
  close: () => {}, usePanelInfo: unusedHook, useRemoteAccess: unusedHook,
  useSessions: unusedHook, useSessionStatus: unusedHook, useSessionRetainInfo: unusedHook, useSessionAccess: unusedHook,
  useWorkspaces: unusedHook, useWorkspaceAccess: unusedHook, useResource: unusedHook,
}

it('opens the account center from the signed-in sidebar menu without starting another authorization', () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  try {
    const page = mount(signedOut, {}, true)
    fireEvent.click(screen.getByRole('button', { name: en.menu }))
    expect(screen.queryByRole('menuitem', { name: 'User center' })).toBeNull()
    page.changeAccount({ ...signedIn, license: null })
    fireEvent.click(screen.getByRole('menuitem', { name: 'User center' }))
    expect(open).toHaveBeenCalledExactlyOnceWith(center, '_blank', 'noopener,noreferrer')
    expect(page.startSignIn).not.toHaveBeenCalled()
  } finally { open.mockRestore() }
})

it('sends the old usage entry to the account center and requests no desktop usage records', () => {
  let snapshot: RelaySnapshot = { view: signedIn, failed: false }
  const loadUsage = vi.fn(async () => ({ ok: false as const, message: 'unexpected usage request' }))
  const props = { t, loadUsage, useRelay: <U,>(select: (value: RelaySnapshot) => U): U => select(snapshot) }
  const element = () => <RelayUsageSection {...unusedSettingsProps} {...props} />
  const rendered = render(element())
  expect(loadUsage).not.toHaveBeenCalled()
  const link = screen.getByRole('link', { name: 'User center' })
  expect(link.getAttribute('href')).toBe(center)
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toContain('noreferrer')
  snapshot = { view: signedOut, failed: false }
  rendered.rerender(element())
  expect(screen.queryByRole('link')).toBeNull()
})
