/** Relay account settings: browser sign-in through the website, then manage the card-key license. */
import { useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, PropsLocale, InjectFace, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  RelayAccountErrorCode, RelayCommandResult, RelayLicenseOutcome, RelayShopBuyOutcome, RelayShopCatalogResult,
  RelayShopOrdersResult, RelayView,
} from '@deepseek-ai/dsh-api-remotes/client'
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
  /** @returns benefit packs on sale plus the wallet currency. */
  shopCatalog: () => Promise<RelayShopCatalogResult>
  /** @param productId - catalog product id. @returns outcome with the issued order. */
  shopBuyWithBalance: (productId: number) => Promise<RelayShopBuyOutcome>
  /** @param productId - catalog product id the code belongs to. @param cardKey - activation code. @returns outcome with the issued order. */
  shopBuyWithCard: (productId: number, cardKey: string) => Promise<RelayShopBuyOutcome>
  /** @returns the account's shop orders, newest first. */
  shopOrders: () => Promise<RelayShopOrdersResult>
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
  return view.account.status === 'signed-in' ? <SignedIn key={view.account.profile?.id} {...props} view={view} /> : <SignedOut {...props} view={view} />
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

function SignedIn(props: RelayAccountSectionProps & { view: RelayView }) {
  const { t, view, logout, activate, redeem, refreshBalance } = props
  const [cardKey, setCardKey] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | undefined>(undefined)
  const license = view.license
  const [shopOpen, setShopOpen] = useState(false)
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

      {/* Benefit pack: free-model entitlement. Expiry only gates the free models; balance and premium models keep working. */}
      <div className={css.card}>
        <div className={css.row}>
          <h3 className={css.title}>{t('planTitle')}</h3>
          {license?.activated === true && (
            <span className={license.planActive ? css.ok : css.expired}>
              {t(license.planActive ? 'planActive' : 'planExpired')}
            </span>
          )}
        </div>
        {license?.activated === true && license.cardKey !== '' ? (
          <dl className={css.facts}>
            <dt>{t('planExpires')}</dt>
            <dd>{license.planExpiresAt === null ? t('permanent') : formatBeijingTime(license.planExpiresAt)}</dd>
            <dt>{t('cardKey')}</dt>
            <dd>{license.cardKey}</dd>
          </dl>
        ) : <p className={css.description}>{t('planNone')}</p>}
        <form className={css.inline} onSubmit={(event) => { event.preventDefault(); void run(() => activate(cardKey), 'activated', () => { setCardKey('') }) }}>
          <Input placeholder={t('planCodePlaceholder')} value={cardKey} onChange={(event) => { setCardKey(event.target.value) }} />
          <Button type="submit" variant="primary" disabled={busy || cardKey.trim() === ''}>{t('activate')}</Button>
        </form>
        <p className={css.secondary}>{t('planHint')}</p>
      </div>

      {/* Balance: premium models bill per use. Independent from the benefit pack; expiry never blocks paid requests. */}
      <div className={css.card}>
        <div className={css.row}>
          <h3 className={css.title}>{t('balanceTitle')}</h3>
          {license?.billingEnabled === true && <span className={css.balance}>{license.balance.toFixed(2)} {license.currency}</span>}
        </div>
        {license?.activated === true ? (
          <form className={css.inline}
            onSubmit={(event) => { event.preventDefault(); void run(() => redeem(code), 'redeemed', () => { setCode('') }) }}>
            <Input placeholder={t('topupPlaceholder')} value={code} onChange={(event) => { setCode(event.target.value) }} />
            <Button type="submit" variant="outline" disabled={busy || code.trim() === ''}>{t('redeem')}</Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => { void refreshBalance() }}>{t('refreshBalance')}</Button>
          </form>
        ) : <p className={css.description}>{t('balanceNeedSession')}</p>}
        <p className={css.secondary}>{t('balanceHint')}</p>
        {notice !== undefined && <p className={notice.ok ? css.success : css.error} role={notice.ok ? 'status' : 'alert'}>{notice.text}</p>}
      </div>

      {/* Shop: benefit packs bought with balance or a product activation code. */}
      <div className={css.card}>
        <div className={css.row}>
          <h3 className={css.title}>{t('shopTitle')}</h3>
          <Button variant="outline" onClick={() => { setShopOpen(open => !open) }}>{t(shopOpen ? 'shopHide' : 'shopOpen')}</Button>
        </div>
        {shopOpen && <Shop {...props} balance={license?.balance ?? 0} billingEnabled={license?.billingEnabled === true} />}
      </div>
    </section>
  )
}


/** Shop panel: benefit packs buyable with wallet balance or a product activation code. */
function Shop({ t, shopCatalog, shopBuyWithBalance, shopBuyWithCard, shopOrders, balance, billingEnabled }:
  RelayAccountSectionProps & { balance: number; billingEnabled: boolean }) {
  const [catalog, setCatalog] = useState<RelayShopCatalogResult | undefined>(undefined)
  const [orders, setOrders] = useState<RelayShopOrdersResult | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [codeById, setCodeById] = useState<Readonly<Record<number, string>>>({})
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | undefined>(undefined)

  useEffect(() => {
    let live = true
    setLoading(true)
    void Promise.all([shopCatalog(), shopOrders()]).then(([c, o]) => {
      if (live) { setCatalog(c); setOrders(o); setLoading(false) }
    }).catch(() => {
      if (live) { setCatalog({ ok: false, message: t('errorGeneric') }); setLoading(false) }
    })
    return () => { live = false }
    // Mount-only load; the injected calls are stable across renders.
  }, [shopCatalog, shopOrders, t])

  const reload = async () => {
    const [c, o] = await Promise.all([shopCatalog(), shopOrders()])
    setCatalog(c); setOrders(o)
  }
  const buy = async (productId: number, action: () => Promise<RelayShopBuyOutcome>) => {
    setBusyId(productId)
    setNotice(undefined)
    try {
      const outcome = await action()
      setNotice({ ok: outcome.ok, text: outcome.message })
      if (outcome.ok) await reload()
    } catch { setNotice({ ok: false, text: t('errorGeneric') }) } finally { setBusyId(null) }
  }

  const items = catalog?.ok === true ? catalog.catalog.items : []
  const currency = catalog?.ok === true ? catalog.catalog.currency : ''
  return (
    <div className={css.shop} aria-busy={loading}>
      {catalog?.ok === false && <p className={css.error} role="alert">{catalog.message}</p>}
      {items.length === 0 && !loading && catalog?.ok === true && <p className={css.description}>{t('shopEmpty')}</p>}
      {items.map(item => (
        <div key={item.id} className={css.product}>
          <div className={css.productCopy}>
            <span className={css.name}>{item.name}</span>
            <span className={css.secondary}>
              {t('shopDays').replace('{days}', String(item.durationDays))}
              {item.description === '' ? '' : ' · ' + item.description}
            </span>
          </div>
          <div className={css.productBuy}>
            <span className={css.price}>{item.price.toFixed(2)} {currency}</span>
            <Button variant="primary" disabled={busyId !== null || (billingEnabled && balance < item.price)}
              onClick={() => { void buy(item.id, () => shopBuyWithBalance(item.id)) }}>
              {busyId === item.id ? t('working') : t('shopBuyBalance')}
            </Button>
          </div>
          <form className={css.inline} onSubmit={(event) => {
            event.preventDefault()
            const key = (codeById[item.id] ?? '').trim()
            if (key === '') return
            void buy(item.id, () => shopBuyWithCard(item.id, key)).then(() => {
              setCodeById(prev => ({ ...prev, [item.id]: '' }))
            })
          }}>
            <Input placeholder={t('shopCodePlaceholder')} value={codeById[item.id] ?? ''}
              onChange={(event) => { setCodeById(prev => ({ ...prev, [item.id]: event.target.value })) }} />
            <Button type="submit" variant="outline" disabled={busyId !== null || (codeById[item.id] ?? '').trim() === ''}>{t('shopBuyCode')}</Button>
          </form>
        </div>
      ))}
      {orders?.ok === true && orders.orders.length > 0 && (
        <div className={css.orders}>
          <p className={css.secondary}>{t('shopOrdersTitle')}</p>
          {orders.orders.slice(0, 5).map(order => (
            <div key={order.id} className={css.orderRow}>
              <span className={css.name}>{order.productName}</span>
              <span className={css.secondary}>
                {t(order.payMethod === 'balance' ? 'shopPayBalance' : 'shopPayCode')} · {order.amount.toFixed(2)} {currency}
                {order.refunded ? ' · ' + t('shopRefunded') : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      {notice !== undefined && <p className={notice.ok ? css.success : css.error} role={notice.ok ? 'status' : 'alert'}>{notice.text}</p>}
    </div>
  )
}