// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Welcome } from '../src/client/WelcomePage.tsx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { RelayWelcomeActivation, RelayWelcomeState } from '../src/welcome-api.ts'

const html = readFileSync(join(import.meta.dirname, '../renderer/welcome.html'), 'utf8')
afterEach(cleanup)

const idle: RelayWelcomeState = { configured: true, signedIn: false, email: '', signIn: { phase: 'idle' }, licensed: false, licenseMessage: '' }
const waiting: RelayWelcomeState = { ...idle, signIn: { phase: 'waiting-browser', authorizeUrl: 'https://example.test/login' } }
const signedIn: RelayWelcomeState = { ...idle, signedIn: true, email: 'user@example.test' }

function mount(language = 'zh-CN', initial: RelayWelcomeState = idle) {
  cleanup()
  const stopRelay = vi.fn()
  const api = {
    analytics: vi.fn(async (_event: string, _attributes: object) => {}),
    analyticsEnabled: async () => true,
    onRelayState: vi.fn((_listener: (state: RelayWelcomeState) => void) => stopRelay),
    readRelay: vi.fn(async () => initial),
    startSignIn: vi.fn(async () => waiting),
    cancelSignIn: vi.fn(async () => idle),
    copySignInLink: vi.fn(async () => undefined),
    activate: vi.fn<(cardKey: string) => Promise<RelayWelcomeActivation>>().mockResolvedValue({ ok: true, message: 'ok' }),
    signOut: vi.fn(async () => idle),
    ...resolveDesktopLocale(language),
  }
  const mounted = render(<Welcome api={api} />)
  const input = document.querySelector('input')!
  const button = (id: string) => document.querySelector<HTMLButtonElement>(id)!
  const submit = () => fireEvent.submit(document.querySelector('form')!)
  const push = (state: RelayWelcomeState) => { act(() => { api.onRelayState.mock.calls[0]![0](state) }) }
  const copy = () => {
    const heading = document.querySelector('main')!.getAttribute('aria-labelledby')!
    return [
      document.title, document.querySelector('img')!.alt, document.getElementById(heading)!.textContent,
      ...heading === 'welcome-heading' ? [document.querySelector('#welcome-description')!.textContent] : [],
      ...heading === 'key-title' ? [document.querySelector('#key-description')!.textContent, `${input.placeholder} [text]`] : [],
      ...heading === 'auth-status' && !document.querySelector<HTMLElement>('#auth-description')!.hidden
        ? [document.querySelector('#auth-description')!.textContent] : [],
      ...[...document.querySelectorAll('button')].filter(item => item.closest('[hidden]') === null)
        .map(item => `${item.textContent || item.getAttribute('aria-label')}${item.disabled ? ' [disabled]' : ''}`),
      '',
    ].join('\n')
  }
  return { document, api, input, button, submit, push, copy, unmount: mounted.unmount, stopRelay }
}

describe('desktop welcome presentation', () => {
  it.each(['zh-CN', 'en'])('renders the %s entry, browser fallback and card-key step', async (language) => {
    const view = mount(language)
    expect(view.document.documentElement.lang).toBe(language)
    expect(view.document.querySelector('img')!.getAttribute('src')).toBe('assets/welcome-brand.svg')
    await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}.expected.txt`)
    view.push(waiting)
    await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}-waiting.expected.txt`)
    view.push(signedIn)
    expect(view.document.activeElement).toBe(view.input)
    await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}-activate.expected.txt`)
  })

  it('starts sign-in once from the entry and reports the click', async () => {
    const view = mount()
    fireEvent.click(view.button('#sign-in'))
    await act(async () => {})
    expect(view.api.startSignIn).toHaveBeenCalledOnce()
    expect(view.api.analytics).toHaveBeenCalledExactlyOnceWith('auth_page_click', { button_name: 'sign_in' })
    expect(view.document.querySelector<HTMLElement>('#auth-page')!.hidden).toBe(false)
  })

  it('opens directly on the card-key step when the snapshot is already signed in', async () => {
    const view = mount('en', signedIn)
    await act(async () => {})
    expect(view.document.querySelector<HTMLElement>('#key-form')!.hidden).toBe(false)
    expect(view.document.querySelector('#key-description')!.textContent).toContain('user@example.test')
  })

  it('sends one trimmed card key and clears it after activation', async () => {
    const view = mount('zh-CN', signedIn)
    await act(async () => {})
    const activated = Promise.withResolvers<RelayWelcomeActivation>()
    view.api.activate.mockReturnValue(activated.promise)
    fireEvent.change(view.input, { target: { value: '  ABCD-EFGH  ' } })
    view.submit()
    view.submit()
    expect(view.api.activate).toHaveBeenCalledExactlyOnceWith('ABCD-EFGH')
    expect(view.button('#save-key').disabled).toBe(true)
    expect(view.button('#back-to-login').disabled).toBe(true)
    await act(async () => { activated.resolve({ ok: true, message: 'ok' }); await activated.promise })
    expect(view.input.value).toBe('')
  })

  it('does not send an empty key and keeps the draft with the server message after a refusal', async () => {
    const view = mount('zh-CN', signedIn)
    await act(async () => {})
    view.submit()
    expect(view.api.activate).not.toHaveBeenCalled()
    view.api.activate.mockResolvedValueOnce({ ok: false, message: 'card expired' })
    fireEvent.change(view.input, { target: { value: 'BAD' } })
    view.submit()
    await vi.waitFor(() => { expect(view.button('#save-key').disabled).toBe(false) })
    expect(view.input.value).toBe('BAD')
    expect(view.document.querySelector('#key-error')!.textContent).toBe('card expired')
    expect(view.input.getAttribute('aria-invalid')).toBe('true')
    view.api.activate.mockRejectedValueOnce(new Error('ipc closed'))
    view.submit()
    await vi.waitFor(() => { expect(view.document.querySelector('#key-error')!.textContent).toBe(view.api.messages.welcomeActivateFailed) })
  })

  it('signs out from the card-key step and returns to the entry', async () => {
    const view = mount('en', signedIn)
    await act(async () => {})
    fireEvent.change(view.input, { target: { value: 'DRAFT' } })
    fireEvent.click(view.button('#back-to-login'))
    await act(async () => {})
    expect(view.api.signOut).toHaveBeenCalledOnce()
    expect(view.document.querySelector<HTMLElement>('#key-form')!.hidden).toBe(true)
    expect(view.button('#sign-in').closest('[hidden]')).toBeNull()
    expect(view.input.value).toBe('')
  })

  it('shows retry for a failed attempt and a configuration hint when the backend is unset', () => {
    const view = mount()
    view.push({ ...idle, signIn: { phase: 'failed', error: 'not-configured' } })
    expect(view.button('#auth-retry').hidden).toBe(false)
    expect(view.document.querySelector('#auth-status')!.textContent).toBe(view.api.messages.welcomeNotConfigured)
    view.push({ ...idle, signIn: { phase: 'failed', error: 'rejected' } })
    expect(view.document.querySelector('#auth-status')!.textContent).toBe(view.api.messages.welcomeAuthRejected)
  })

  it('cancels a waiting attempt back to the entry', async () => {
    const view = mount()
    view.push(waiting)
    fireEvent.click(view.button('#auth-cancel'))
    await act(async () => {})
    expect(view.api.cancelSignIn).toHaveBeenCalledOnce()
    expect(view.button('#sign-in').closest('[hidden]')).toBeNull()
  })

  it('keeps visible copy in the shell dictionaries and denies network access', () => {
    expect([...html.matchAll(/>([^<]*\p{L}[^<]*)</gu)]).toEqual([])
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("form-action 'none'")
  })

  it('keeps the card draft across relay notifications and releases the subscription on unmount', async () => {
    const view = mount('en', signedIn)
    await act(async () => {})
    fireEvent.change(view.input, { target: { value: 'KEEP' } })
    view.push(signedIn)
    expect(view.input.value).toBe('KEEP')
    view.unmount()
    expect(view.stopRelay).toHaveBeenCalledOnce()
  })
})

it.each(['copied', 'failed'] as const)('restores the copy action after %s feedback and cleans up on unmount', async (result) => {
  vi.useFakeTimers()
  try {
    const view = mount('en')
    if (result === 'failed') view.api.copySignInLink.mockRejectedValue(new Error('clipboard unavailable'))
    await act(async () => {})
    view.push(waiting)
    const feedback = result === 'copied' ? view.api.messages.welcomeAuthCopied : view.api.messages.welcomeAuthCopyFailed
    await act(async () => { fireEvent.click(view.button('#auth-copy')) })
    expect(view.api.copySignInLink).toHaveBeenCalledOnce()
    expect(view.button('#auth-copy').textContent).toBe(feedback)
    expect(view.button('#auth-copy').disabled).toBe(result === 'copied')
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(view.button('#auth-copy').textContent).toBe(view.api.messages.welcomeAuthCopyLink)
    expect(view.button('#auth-copy').disabled).toBe(false)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})
