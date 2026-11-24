/** Background image settings: choose, preview, clear, and tune how opaque the panels are over the image. */
import { useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, PropsLocale, InjectFace, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { BackgroundSnapshot, ChooseResult } from './controller.ts'
import { MAX_OPACITY, MIN_OPACITY } from './controller.ts'
import type { BackgroundImageKey } from './locales.ts'
import css from './BackgroundSection.module.css'

/** Host operations injected into the Cordis-free background component. */
export interface BackgroundInjected {
  hooks: { background: HostObservable<BackgroundSnapshot> }
  /** @param file - image chosen by the user. @returns whether it was saved on this device. */
  choose: (file: File) => Promise<ChooseResult>
  clear: () => Promise<void>
  /** @param percent - panel opacity over the image. */
  setOpacity: (percent: number) => Promise<void>
}

/** Composed background section props. */
export type BackgroundSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'settings.background-image'> & InjectFace<BackgroundInjected>

const ERROR_KEY = { 'not-image': 'errorNotImage', 'too-large': 'errorTooLarge', storage: 'errorStorage' } as const satisfies Record<string, BackgroundImageKey>

/** @param props - localized copy, snapshot and actions. @returns background settings UI. */
export function BackgroundSection({ t, useBackground, choose, clear, setOpacity }: BackgroundSectionProps) {
  const { hasImage, previewUrl, opacity } = useBackground(value => value)
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<BackgroundImageKey | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const onFile = async (file: File | undefined) => {
    if (file === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await choose(file)
      if (!result.ok) setError(ERROR_KEY[result.reason])
    } finally { setBusy(false) }
  }
  return (
    <section className={css.section} aria-label={t('title')}>
      <p className={css.secondary}>{t('description')}</p>
      <div className={css.card}>
        {previewUrl !== undefined
          ? <img className={css.preview} src={previewUrl} alt={t('previewAlt')} />
          : <div className={css.empty}>{t('none')}</div>}
        <div className={css.actions}>
          <Button type="button" disabled={busy} onClick={() => input.current?.click()}>{hasImage ? t('replace') : t('choose')}</Button>
          {hasImage && <Button type="button" variant="outline" disabled={busy} onClick={() => { void clear() }}>{t('clear')}</Button>}
          <input
            ref={input} className={css.hidden} type="file" accept="image/*" aria-label={t('choose')} tabIndex={-1}
            onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void onFile(file) }}
          />
        </div>
        {error !== undefined && <p className={css.error} role="alert">{t(error)}</p>}
        <label className={css.slider}>
          <span>{t('opacity', { percent: opacity })}</span>
          <input
            type="range" min={MIN_OPACITY} max={MAX_OPACITY} step={5} value={opacity} disabled={!hasImage}
            onChange={(event) => { void setOpacity(Number(event.currentTarget.value)) }}
          />
        </label>
        <p className={css.secondary}>{t('localOnly')}</p>
      </div>
    </section>
  )
}
