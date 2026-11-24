/** The relay operator's announcement, shown over the app frame until withdrawn or dismissed. */
import type { ReactNode } from 'react'
import { IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'shell.overlay' entry).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { AnnouncementWatcher } from './announcement.ts'
import css from './RelayAnnouncementBanner.module.css'

/** Registrant-private face: the shown announcement and its dismissal. */
export type RelayAnnouncementInjected = Pick<AnnouncementWatcher, 'hooks' | 'dismiss'>

/** Props of the `shell.overlay` entry: the announcement hook, its dismissal, and localized copy. */
export type RelayAnnouncementBannerProps =
  PropsRuntime<'shell.overlay'> & PropsLocale<'settings.relay-account'> & InjectFace<RelayAnnouncementInjected>

/**
 * Render the published announcement in the operator's level, with a close button.
 * @param props - the announcement hook, its dismissal, and the locale seat.
 * @returns the banner, or null while no announcement shows.
 */
export function RelayAnnouncementBanner({ useAnnouncement, dismiss, t }: RelayAnnouncementBannerProps): ReactNode {
  const announcement = useAnnouncement(current => current)
  if (announcement === null) return null
  return (
    <div className={css.banner} data-level={announcement.level} role="status" aria-label={t('announcement')}>
      <div className={css.main}>
        <strong className={css.title}>{announcement.title === '' ? t('announcement') : announcement.title}</strong>
        <p className={css.content}>{announcement.content}</p>
      </div>
      <button type="button" className={css.close} aria-label={t('announcementClose')} onClick={dismiss}>
        <IconCloseOutlineRegular size={14} />
      </button>
    </div>
  )
}
