/** Relay account settings: browser sign-in through the website, then manage the card-key license. */
import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, PropsLocale, InjectFace, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RelayAccountErrorCode, RelayCommandResult, RelayLicenseOutcome, RelayView } from '@deepseek-ai/dsh-api-remotes/client'
import type { RelayAccountKey } from './locales.ts'
import css from './RelayAccountSection.module.css'

const BEIJING_TIME = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

/** @param iso - server UTC timestamp. @returns `YYYY-MM-DD HH:mm:ss` in Beijing time, or `iso` when unparsable. */
function formatBeijingTime(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : BEIJING_TIME.format(at)
}

/** Latest Host snapshot; undefined until the stream responds. */
export interface RelaySnapshot {
  readonly view: RelayView | undefined
  /** Whether the state stream failed. */
  readonly failed: boolean
}

/** Host operations injected into the Cordis-free relay component. */
export interface RelayAccountInjected {
  hooks: { relay: HostObservable<RelaySnapshot> }
  /** @returns outcome of starting browser authorization; the page to open is in the snapshot. */
  startSignIn: () => Promise<RelayCommandResult>
  cancelSignIn: () => Promise<void>
  logout: () => Promise<void>
  /** @param cardKey - card key to activate. @returns outcome with the backend message. */
  activate: (cardKey: string) => Promise<RelayLicenseOutcome>
  /** @param code - top-up code. @returns outcome with the backend message. */
  redeem: (code: string) => Promise<RelayLicenseOutcome>
  refreshBalance: () => Promise<void>
}

/** Composed relay section props. */
export type RelayAccountSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'settings.relay-account'> & InjectFace<RelayAccountInjected>

const ERROR_KEY: Readonly<Record<RelayAccountErrorCode, RelayAccountKey>> = {
  'not-configured': 'notConfigured', network: 'errorNetwork', unauthorized: 'errorUnauthorized', rejected: 'errorRejected',
  'invalid-response': 'errorGeneric', 'invalid-image': 'errorInvalidImage', 'signed-out': 'errorUnauthorized', storage: 'errorGeneric',
}

/** @param props - localized copy, Host snapshot and actions. @returns relay account settings UI. */
export function RelayAccountSection(props: RelayAccountSectionProps) {
  const { t, useRelay } = props
  const { view, failed: streamFailed } = useRelay(value => value)
  if (view === undefined) return <section className={css.section} aria-label={t('nav')}><p role="status">{streamFailed ? t('errorGeneric') : ''}</p></section>
  if (!view.configured) return <section className={css.section} aria-label={t('nav')}><p role="status">{t('notConfigured')}</p></section>
  return view.account.status === 'signed-in' ? <SignedIn {...props} view={view} /> : <SignedOut {...props} view={view} />
}

function SignedOut({ t, view, startSignIn, cancelSignIn }: RelayAccountSectionProps & { view: RelayView }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RelayAccountKey | undefined>(undefined)
  const signIn = view.account.signIn
  const waiting = signIn.phase === 'waiting-browser' || signIn.phase === 'exchanging'
  const start = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await startSignIn()
      if (!result.ok) setError(ERROR_KEY[result.code])
    } catch { setError('errorGeneric') } finally { setBusy(false) }
  }
  const failure = error ?? (signIn.phase === 'failed' && signIn.code !== undefined ? ERROR_KEY[signIn.code] : undefined)
  return (
    <section className={css.section} aria-label={t('nav')}>
      <div className={css.card}>
        <h3 className={css.title}>{t('signedOutTitle')}</h3>
        <p className={css.description}>{t('signedOutDescription')}</p>
        {waiting ? <>
          <p className={css.description} role="status">{t(signIn.phase === 'exchanging' ? 'browserExchanging' : 'browserWaiting')}</p>
          {signIn.authorizeUrl !== undefined && <a href={signIn.authorizeUrl} target="_blank" rel="noreferrer">{t('browserOpenLink')}</a>}
          <Button type="button" variant="outline" onClick={() => { void cancelSignIn() }}>{t('browserCancel')}</Button>
        </> : <Button type="button" variant="primary" disabled={busy} onClick={() => { void start() }}>
          {busy ? t('working') : t('browserSignIn')}
        </Button>}
        {failure !== undefined && <p className={css.error} role="alert">{t(failure)}</p>}
      </div>
    </section>
  )
}

function SignedIn({ t, view, logout, activate, redeem, refreshBalance }: RelayAccountSectionProps & { view: RelayView }) {
  const [cardKey, setCardKey] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | undefined>(undefined)
  const license = view.license
  const run = async (action: () => Promise<RelayLicenseOutcome>, success: RelayAccountKey, clear: () => void) => {
    setBusy(true)
    setNotice(undefined)
    try {
      const outcome = await action()
      setNotice({ ok: outcome.ok, text: outcome.ok ? t(success) : outcome.message })
      if (outcome.ok) clear()
    } catch { setNotice({ ok: false, text: t('errorGeneric') }) } finally { setBusy(false) }
  }
  return (
    <section className={css.section} aria-label={t('nav')}>
      <div className={css.card}>
        <div className={css.row}>
          <div className={css.identity}>
            {view.account.profile?.avatarUrl != null && <img className={css.avatar} src={view.account.profile.avatarUrl} alt="" referrerPolicy="no-referrer" />}
            <div className={css.identityCopy}>
              <span className={css.secondary}>{t('signedInAs')}</span>
              <span className={css.name}>{view.account.profile?.email}</span>
            </div>
          </div>
          <Button variant="outline" onClick={() => { void logout() }}>{t('signOut')}</Button>
        </div>
      </div>
      <div className={css.card}>
        <h3 className={css.title}>{t('licenseTitle')}</h3>
        {license?.activated === true && <dl className={css.facts}>
          {license.cardKey !== '' && <>
            <dt>{t('cardKey')}</dt><dd>{license.cardKey} · {t(license.planActive ? 'licenseValid' : 'licenseExpired')}</dd>
            <dt>{t('device')}</dt><dd>{license.deviceName}</dd>
            <dt>{t('expires')}</dt><dd>{license.cardExpiresAt === null ? t('permanent') : formatBeijingTime(license.cardExpiresAt)}</dd>
          </>}
          {license.billingEnabled && <><dt>{t('balance')}</dt><dd>{license.balance.toFixed(2)} {license.currency}</dd></>}
        </dl>}
        {(license?.activated !== true || license.cardKey === '') && <p className={css.description}>{t('licenseNone')}</p>}
        <form className={css.inline} onSubmit={(event) => { event.preventDefault(); void run(() => activate(cardKey), 'activated', () => { setCardKey('') }) }}>
          <Input placeholder={t('cardKeyPlaceholder')} value={cardKey} onChange={(event) => { setCardKey(event.target.value) }} />
          <Button type="submit" variant="primary" disabled={busy || cardKey.trim() === ''}>{t('activate')}</Button>
        </form>
        {license?.activated === true && <form className={css.inline}
          onSubmit={(event) => { event.preventDefault(); void run(() => redeem(code), 'redeemed', () => { setCode('') }) }}>
          <Input placeholder={t('topupPlaceholder')} value={code} onChange={(event) => { setCode(event.target.value) }} />
          <Button type="submit" variant="outline" disabled={busy || code.trim() === ''}>{t('redeem')}</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => { void refreshBalance() }}>{t('refreshBalance')}</Button>
        </form>}
        {notice !== undefined && <p className={notice.ok ? css.success : css.error} role={notice.ok ? 'status' : 'alert'}>{notice.text}</p>}
      </div>
    </section>
  )
}
