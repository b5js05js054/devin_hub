/** Parameter popover beside the model seat, shown only while the selected model is an image or video model. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, IconSettingsOutlineMedium, Tooltip, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { MediaField, MediaParams, MediaSpecResult } from '@deepseek-ai/dsh-api-media-controller/types'
import css from './MediaParamsPanel.module.css'

/** Business face of the panel. */
export interface MediaParamsInjected {
  readonly hooks: { readonly directory: HostObservable<{ readonly current: { readonly model: string } | null }> }
  /** Ask the relay which parameters `model` accepts. */
  readonly getSpec: (model: string) => Promise<MediaSpecResult>
  /** Remember the values for `model` in this session; an empty object clears them. */
  readonly setParams: (model: string, params: MediaParams) => Promise<void>
}

/** Props of the panel registered at `conversation.input.media`. */
export type MediaParamsPanelProps = PropsLocale<'media-params'> & InjectFace<MediaParamsInjected>

type Loaded = { readonly model: string; readonly state: 'loading' | 'failed' | 'chat' | { readonly fields: readonly MediaField[]; readonly confirmed: boolean } }

/**
 * @param fields - spec fields.
 * @returns each field's default value, skipping fields without one.
 */
function defaultsOf(fields: readonly MediaField[]): Record<string, string | number> {
  const values: Record<string, string | number> = {}
  for (const field of fields) if (field.default !== null) values[field.key] = field.default
  return values
}

/** @param props - selected-model hook, spec lookup, value sink and localizer. @returns the panel, or nothing for chat models. */
export function MediaParamsPanel({ useDirectory, getSpec, setParams, t }: MediaParamsPanelProps) {
  const selected = useDirectory(state => state.current?.model)
  const [loaded, setLoaded] = useState<Loaded | undefined>()
  const [values, setValues] = useState<Record<string, string | number>>({})
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useDismissOnOutsidePointer(root, open, setOpen)

  const load = useCallback((id: string) => {
    setLoaded({ model: id, state: 'loading' })
    getSpec(id).then((result) => {
      if (result.ok) {
        const defaults = defaultsOf(result.spec.fields)
        setValues(defaults)
        setLoaded({ model: id, state: { fields: result.spec.fields, confirmed: result.spec.source === 'upstream' } })
        void setParams(id, defaults)
      } else {
        setLoaded({ model: id, state: result.code === 'not-media' ? 'chat' : 'failed' })
      }
    }, () => { setLoaded({ model: id, state: 'failed' }) })
  }, [getSpec, setParams])

  useEffect(() => {
    setOpen(false)
    if (selected === undefined) { setLoaded(undefined); return }
    load(selected)
  }, [selected, load])

  if (selected === undefined || loaded?.model !== selected || loaded.state === 'chat' || loaded.state === 'loading') return null
  const change = (key: string, value: string | number): void => {
    const next = { ...values, [key]: value }
    setValues(next)
    void setParams(selected, next)
  }
  return <div ref={root} className={css.root}>
    <Tooltip label={t('open')} side="top">
      <button type="button" className={css.trigger} aria-label={t('open')} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}>
        <IconSettingsOutlineMedium size={16} />
      </button>
    </Tooltip>
    {open && <div className={css.surface} role="dialog" aria-label={t('title')}>
      <h3 className={css.title}>{t('title')}</h3>
      {loaded.state === 'failed'
        ? <>
          <p className={css.note} role="alert">{t('loadFailed')}</p>
          <Button className={css.retry} onClick={() => { load(selected) }}>{t('retry')}</Button>
        </>
        : <>
          {loaded.state.fields.map(field => <label key={field.key} className={css.field}>
            <span className={css.label}>{field.label}</span>
            {field.type === 'select'
              ? <select className={css.control} value={String(values[field.key] ?? '')}
                onChange={(event) => { change(field.key, event.target.value) }}>
                {(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
              </select>
              : <input className={css.control} type="number" min={field.min} max={field.max} value={String(values[field.key] ?? '')}
                onChange={(event) => { if (event.target.value !== '') change(field.key, Number(event.target.value)) }} />}
          </label>)}
          {!loaded.state.confirmed && <p className={css.note}>{t('unconfirmed')}</p>}
        </>}
    </div>}
  </div>
}
