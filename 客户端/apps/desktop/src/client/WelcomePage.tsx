/** Desktop welcome presentation; relay account operations stay in the preload. */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'
import type { RelayWelcomeState, WelcomeApi } from '../welcome-api.ts'

const IDLE: RelayWelcomeState = { configured: true, signedIn: false, email: '', signIn: { phase: 'idle' }, licensed: false, licenseMessage: '' }

/**
 * Render the standalone welcome flow: sign in through the website, then activate a card key.
 * The page follows the relay snapshot pushed by the shell, so a callback landing in the browser advances it.
 * @param props.api - isolated preload API; no tokens reach the renderer.
 * @returns welcome pages with fixed bottom actions.
 */
export function Welcome({ api }: { api: WelcomeApi }) {
  const { messages: m } = api
  const [relay, setRelay] = useState<RelayWelcomeState>(IDLE)
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'busy' | 'copied' | 'failed'>('idle')
  const [card, setCard] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    mounted.current = true
    document.documentElement.lang = api.id
    document.title = m.welcomeTitle
    const stop = api.onRelayState((state) => { if (mounted.current) { setRelay(state); setStarting(false) } })
    void api.readRelay().then((state) => { if (mounted.current) setRelay(state) }).catch(() => undefined)
    return () => { mounted.current = false; stop() }
  }, [api, m.welcomeTitle])

  useEffect(() => {
    if (copyState !== 'copied' && copyState !== 'failed') return
    const timer = setTimeout(() => { setCopyState('idle') }, 2000)
    return () => { clearTimeout(timer) }
  }, [copyState])

  const activating = relay.signedIn
  const phase = relay.signIn.phase
  const page = activating ? 'activate' : starting || phase !== 'idle' ? 'auth' : 'entry'
  useEffect(() => {
    document.title = m.welcomeTitle
    if (page === 'activate') input.current?.focus()
  }, [page, m.welcomeTitle])

  async function start() {
    setStarting(true)
    void api.analytics?.('auth_page_click', { button_name: 'sign_in' })
    try {
      const state = await api.startSignIn()
      if (mounted.current) setRelay(state)
    } catch { /* The page keeps its previous state; the retry button remains. */ } finally {
      if (mounted.current) setStarting(false)
    }
  }
  async function cancel() {
    if (cancelling) return
    setCancelling(true)
    try {
      const state = await api.cancelSignIn()
      if (mounted.current) setRelay(state)
    } catch { /* The attempt remains visible so cancellation can be retried. */ } finally {
      if (mounted.current) setCancelling(false)
    }
  }
  async function copyLink() {
    if (copyState === 'busy' || copyState === 'copied') return
    setCopyState('busy')
    try {
      await api.copySignInLink()
      if (mounted.current) setCopyState('copied')
    } catch {
      if (mounted.current) setCopyState('failed')
    }
  }
  async function activate(event: FormEvent) {
    event.preventDefault()
    const value = card.trim()
    if (busy || value === '') return
    setBusy(true)
    setError('')
    try {
      const outcome = await api.activate(value)
      if (!mounted.current) return
      if (outcome.ok) setCard('')
      else setError(outcome.message || m.welcomeActivateFailed)
    } catch {
      if (mounted.current) setError(m.welcomeActivateFailed)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  async function signOut() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const state = await api.signOut()
      if (mounted.current) { setRelay(state); setCard('') }
    } catch { /* The account stays signed in; the button remains available. */ } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const failed = !starting && phase === 'failed'
  const waiting = !starting && phase === 'waiting-browser'
  const title = starting ? m.welcomeAuthStarting
    : waiting ? m.welcomeAuthWaiting
      : failed ? (relay.signIn.error === 'not-configured' ? m.welcomeNotConfigured : relay.signIn.error === 'rejected' ? m.welcomeAuthRejected : m.welcomeAuthFailed)
        : m.welcomeAuthExchanging
  const heading = page === 'entry' ? 'welcome-heading' : page === 'activate' ? 'key-title' : 'auth-status'

  return <>
    <div className="titlebar" aria-hidden="true" />
    <main className="welcome" aria-labelledby={heading}>
      <img className="brand" src="assets/welcome-brand.svg" alt={m.welcomeBrand} width="472" height="40" />
      <div id="tagline" className="tagline" hidden={page !== 'entry'}>
        <h1 id="welcome-heading"><span>{m.welcomeTaglineBefore}</span><em>{m.welcomeTaglineBrand}</em><span>{m.welcomeTaglineAfter}</span></h1>
        <p id="welcome-description">{m.welcomeDescription}</p>
      </div>
      <form id="key-form" className="key-form" hidden={page !== 'activate'} noValidate onSubmit={(event) => { void activate(event) }} aria-busy={busy}>
        <header className="key-heading">
          <h1 id="key-title">{m.welcomeActivateTitle}</h1>
          <p id="key-description">{m.welcomeActivateDescription.replace('{email}', relay.email)}</p>
        </header>
        <div className="key-field">
          <label className="visually-hidden" htmlFor="key-input">{m.welcomeActivatePlaceholder}</label>
          <input ref={input} id="key-input" type="text" autoComplete="off" autoCapitalize="off" spellCheck={false} required
            aria-describedby="key-description key-error" aria-invalid={error !== ''} placeholder={m.welcomeActivatePlaceholder}
            value={card} disabled={busy} onChange={(event) => { setCard(event.target.value); setError('') }} />
          <p id="key-error" className="key-error" role="alert" hidden={error === ''}>{error}</p>
        </div>
      </form>
      <section id="auth-page" className={`key-heading ${waiting ? 'auth-waiting' : ''}`} hidden={page !== 'auth'} aria-live="polite">
        <h1 id="auth-status">{title}</h1>
        <p id="auth-description" hidden={!waiting}>{m.welcomeAuthWaitingDescription}</p>
        <button id="auth-copy" className="copy-link" type="button" hidden={!waiting} disabled={!waiting || copyState === 'busy' || copyState === 'copied'} onClick={() => { void copyLink() }}>
          {copyState === 'copied' ? m.welcomeAuthCopied : copyState === 'failed' ? m.welcomeAuthCopyFailed : m.welcomeAuthCopyLink}
        </button>
      </section>
      <div id="auth-actions" className="actions" hidden={page !== 'auth'}>
        <button id="auth-loading" className="primary" type="button" hidden={failed} disabled aria-label={m.welcomeAuthExchanging}>
          <StateDot state="ongoing" size={16} className="welcome-loading" />
        </button>
        <button id="auth-retry" className="primary" type="button" hidden={!failed} onClick={() => { void start() }}>{m.welcomeAuthRetry}</button>
        <button id="auth-cancel" className="secondary" type="button" disabled={cancelling || starting || phase === 'exchanging'}
          onClick={() => { void cancel() }}>{m.welcomeAuthCancel}</button>
      </div>
      <div id="entry-actions" className="actions" hidden={page !== 'entry'}>
        <button id="sign-in" className="primary" type="button" onClick={() => { void start() }}>{m.welcomeSignIn}</button>
      </div>
      <div id="key-actions" className="actions" hidden={page !== 'activate'}>
        <button id="save-key" className="primary" type="submit" form="key-form" disabled={busy || card.trim() === ''}>{m.welcomeActivate}</button>
        <button id="back-to-login" className="back" type="button" disabled={busy} onClick={() => { void signOut() }}>{m.welcomeSignOut}</button>
      </div>
    </main>
  </>
}
