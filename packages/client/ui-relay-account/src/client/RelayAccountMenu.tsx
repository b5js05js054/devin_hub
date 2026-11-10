/** Sidebar account launcher bound to the relay account: avatar, membership expiry and balance. */
import { useEffect, useRef, useState } from 'react'
import { Menu, IconEllipsisOutlineMedium, IconSettingsOutlineMedium, IconUserOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RelayLicenseView } from '@deepseek-ai/dsh-api-remotes/client'
import type { RelayAccountInjected } from './RelayAccountSection.tsx'
import type { RelayAccountKey } from './locales.ts'
import css from './RelayAccountMenu.module.css'

/** Relay launcher composed by the settings shell. */
export type RelayAccountMenuProps = PropsRuntime<'settings.launcher'> & PropsLocale<'settings.relay-account'> & InjectFace<RelayAccountInjected>

/**
 * @param license - the stored card license, absent while signed out.
 * @param t - localizer.
 * @returns the membership expiry line.
 */
function membershipText(license: RelayLicenseView | null, t: (key: RelayAccountKey) => string): string {
  if (license?.activated !== true || license.cardExpiresAt === null && !license.planActive) return t('licenseNone')
  if (license.cardExpiresAt === null) return `${t('expires')}: ${t('permanent')}`
  const date = new Date(license.cardExpiresAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
  return `${t('expires')}: ${date}${license.planActive ? '' : ` (${t('licenseExpired')})`}`
}

/** @param props - sidebar geometry, settings navigation and relay operations. @returns relay account menu launcher. */
export function RelayAccountMenu({
  wide, settingsShortcut, openSettings, useRelay, startSignIn, logout, refreshBalance, t,
}: RelayAccountMenuProps) {
  const { view } = useRelay(value => value)
  const signedIn = view?.account.status === 'signed-in'
  const profile = view?.account.profile
  const license = view?.license ?? null
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (open && signedIn) void refreshBalance().catch(() => undefined) }, [open, signedIn, refreshBalance])
  const info = signedIn ? [
    { id: 'membership', label: <span className={css.info}>{membershipText(license, t)}</span>, disabled: true },
    ...license?.activated === true && license.billingEnabled
      ? [{ id: 'balance', label: <span className={css.info}>{t('balance')}: {license.balance.toFixed(2)} {license.currency}</span>, disabled: true }]
      : [],
  ] : []
  return <div className={css.root}>
    <Menu open={open} side="top" portal autoFocus className={css.anchor}
      anchor={<button ref={trigger} type="button" className={css.trigger} data-collapsed={!wide} aria-label={t('menu')}
        aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        <span className={css.avatar}>
          {signedIn && profile?.avatarUrl != null
            ? <img className={css.image} src={profile.avatarUrl} alt="" referrerPolicy="no-referrer" />
            : signedIn ? <IconUserOutlineMedium size={16} /> : <IconEllipsisOutlineMedium size={14} />}
        </span>
        {wide && <span className={css.label}>{signedIn ? profile?.email : t('more')}</span>}
      </button>}
      items={[
        ...info,
        { id: 'settings', label: t('settings'), icon: <IconSettingsOutlineMedium size={16} />,
          ...settingsShortcut === undefined ? {} : { shortcut: settingsShortcut } },
        ...signedIn ? [{ id: 'signout', label: t('signOut') }] : [{ id: 'signin', label: t('signIn'), icon: <IconUserOutlineMedium size={16} /> }],
      ]}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        setOpen(false)
        if (id === 'settings') { trigger.current?.focus(); openSettings() }
        else if (id === 'signin') void startSignIn().catch(() => undefined)
        else if (id === 'signout') void logout().catch(() => undefined)
      }} />
  </div>
}
