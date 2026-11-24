/** Destination for the existing usage settings entry. Account details live on the relay website. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RelayAccountInjected } from './RelayAccountSection.tsx'
import css from './RelayUsageSection.module.css'

/** Current relay account, as projected by the Host. */
export type RelayUsageInjected = Pick<RelayAccountInjected, 'hooks'>

/** Composed usage section props. */
export type RelayUsageSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'settings.relay-account'> & InjectFace<RelayUsageInjected>

/** @param props - localized copy and the current account. @returns a browser link while signed in. */
export function RelayUsageSection({ t, useRelay }: RelayUsageSectionProps) {
  const { view, failed } = useRelay(value => value)
  if (view === undefined) return failed ? <p role="alert">{t('errorGeneric')}</p> : null
  if (!view.configured) return <p role="status">{t('notConfigured')}</p>
  if (view.account.status === 'signed-out') return <p role="status">{t('usageSignIn')}</p>
  if (view.account.accountCenterUrl === undefined) return <p role="status">{t('errorGeneric')}</p>
  return (
    <section className={css.section} aria-label={t('usageNav')}>
      <p>{t('accountCenterDescription')}</p>
      <a href={view.account.accountCenterUrl} target="_blank" rel="noopener noreferrer">{t('accountCenter')}</a>
    </section>
  )
}
