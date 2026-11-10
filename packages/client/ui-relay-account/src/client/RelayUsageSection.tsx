/** Relay usage settings: totals, per-model spend and paginated model-request records. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { RelayUsageResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { RelayAccountKey } from './locales.ts'
import css from './RelayUsageSection.module.css'

/** Host operation injected into the Cordis-free usage component. */
export interface RelayUsageInjected {
  /**
   * @param days - window in days.
   * @param page - 1-based request-record page.
   * @param pageSize - records per page.
   * @returns usage totals, records or the failure message.
   */
  loadUsage: (days: number, page: number, pageSize: number) => Promise<RelayUsageResult>
}

/** Composed usage section props. */
export type RelayUsageSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'settings.relay-account'> & InjectFace<RelayUsageInjected>

const WINDOWS = [7, 30, 90] as const
const PAGE_SIZE = 20
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 })
const integer = new Intl.NumberFormat('en', { maximumFractionDigits: 0 })

type Usage = Extract<RelayUsageResult, { ok: true }>['usage']
type State = {
  readonly phase: 'loading' | 'failed' | 'ready'
  readonly result: Usage | undefined
  readonly message: string
}

/** @param props - localized copy and the usage loader. @returns usage settings UI. */
export function RelayUsageSection({ t, loadUsage }: RelayUsageSectionProps) {
  const [query, setQuery] = useState({ days: 30, page: 1 })
  const [state, setState] = useState<State>({ phase: 'loading', result: undefined, message: '' })
  const epoch = useRef(0)
  const load = useCallback(async (days: number, page: number) => {
    const request = ++epoch.current
    setState(previous => ({ phase: 'loading', result: previous.result, message: '' }))
    try {
      const result = await loadUsage(days, page, PAGE_SIZE)
      if (request !== epoch.current) return
      setState(previous => result.ok
        ? { phase: 'ready', result: result.usage, message: '' }
        : { phase: 'failed', result: previous.result, message: result.message })
    } catch (_error: unknown) {
      if (request === epoch.current) {
        setState(previous => ({ phase: 'failed', result: previous.result, message: '' }))
      }
    }
  }, [loadUsage])
  useEffect(() => {
    void load(query.days, query.page)
    return () => { epoch.current++ }
  }, [load, query])
  const money = (value: number, currency: string, digits: number = 4) => `${value.toFixed(digits)} ${currency}`.trim()
  const result = state.result
  const records = result?.records
  const pages = records === undefined ? 1 : Math.max(1, Math.ceil(records.total / records.pageSize))
  const start = records === undefined || records.items.length === 0 ? 0 : (records.page - 1) * records.pageSize + 1
  const end = records === undefined || records.items.length === 0 ? 0 : start + records.items.length - 1
  return (
    <section className={css.section} aria-label={t('usageNav')} aria-busy={state.phase === 'loading'}>
      <div className={css.row}>
        <div className={css.tabs} role="tablist" aria-label={t('usageWindow')}>
          {WINDOWS.map(window => (
            <button key={window} type="button" role="tab" className={css.tab} aria-selected={window === query.days}
              onClick={() => { setQuery({ days: window, page: 1 }) }}>
              {t('usageDays', { days: window })}
            </button>
          ))}
        </div>
        <Button type="button" variant="outline" disabled={state.phase === 'loading'}
          onClick={() => { void load(query.days, query.page) }}>{t('usageRefresh')}</Button>
      </div>
      {state.phase === 'loading' && result === undefined && <p className={css.secondary} role="status">{t('usageLoading')}</p>}
      {state.phase === 'failed' && <div className={css.notice}>
        <p className={css.error} role="alert">{state.message === '' ? t('errorGeneric') : state.message}</p>
        <Button type="button" variant="outline" onClick={() => { void load(query.days, query.page) }}>{t('usageRetry')}</Button>
      </div>}
      {result !== undefined && <>
        <div className={css.stats}>
          <Stat label={t('usageTotalCost')} value={money(result.totalCost, result.currency)} />
          <Stat label={t('usageTodayCost')} value={money(result.todayCost, result.currency)} note={t('usageRequestsCount', { count: result.todayRequests })} />
          <Stat label={t('usageTotalRequests')} value={String(result.totalRequests)} />
          <Stat
            label={t('usageTotalTokens')} value={compact.format(result.totalTokens)}
            note={t('usageTokenSplit', { input: compact.format(result.inputTokens), cache: compact.format(result.cacheReadTokens), output: compact.format(result.outputTokens) })}
          />
          <Stat label={t('usageCacheHit')} value={`${(result.cacheHitRate * 100).toFixed(1)}%`} />
        </div>
        <div className={css.card}>
          <h3 className={css.title}>{t('usageByModel', { days: result.days })}</h3>
          {result.models.length === 0
            ? <p className={css.secondary}>{t('usageEmpty')}</p>
            : <div className={css.tableWrap}><table className={css.table}>
              <thead><tr><th scope="col">{t('usageModel')}</th><th scope="col">{t('usageRequests')}</th><th scope="col">{t('usageTokens')}</th><th scope="col">{t('usageCost')}</th></tr></thead>
              <tbody>
                {result.models.map(model => (
                  <tr key={model.model}>
                    <th scope="row">{model.label}</th>
                    <td>{integer.format(model.requests)}</td>
                    <td>{compact.format(model.tokens)}</td>
                    <td>{money(model.cost, result.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>}
        </div>
        <div className={css.card}>
          <h3 className={css.title}>{t('usageDetails')}</h3>
          {records?.items.length === 0
            ? <p className={css.secondary}>{t('usageRecordEmpty')}</p>
            : <div className={css.tableWrap}><table className={`${css.table} ${css.recordsTable}`}>
              <thead><tr>
                <th scope="col">{t('usageTime')}</th><th scope="col">{t('usageModel')}</th>
                <th scope="col">{t('usageInput')}</th><th scope="col">{t('usageCacheReadWrite')}</th>
                <th scope="col">{t('usageOutput')}</th><th scope="col">{t('usageTotal')}</th><th scope="col">{t('usageCost')}</th>
              </tr></thead>
              <tbody>
                {records?.items.map((record) => {
                  const totalInput = record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens
                  const markers = [record.free ? t('usageFree') : '', record.estimated ? t('usageEstimated') : ''].filter(Boolean).join(' · ')
                  return <tr key={`${record.time}:${record.model}:${totalInput}:${record.outputTokens}:${record.cost}`}>
                    <td className={css.time}><time dateTime={record.time}>{formatTime(record.time, t('usageLocale'))}</time></td>
                    <th scope="row">
                      <span title={record.model}>{record.label}</span>
                      {markers !== '' && <span className={css.markers}>{markers}</span>}
                    </th>
                    <td title={t('usageInputTitle', { input: integer.format(record.inputTokens), total: integer.format(totalInput) })}>
                      {integer.format(totalInput)} / {integer.format(record.inputTokens)}
                    </td>
                    <td title={t('usageCacheTitle', { read: integer.format(record.cacheReadTokens), write: integer.format(record.cacheWriteTokens) })}>
                      {integer.format(record.cacheReadTokens)} / {integer.format(record.cacheWriteTokens)}
                    </td>
                    <td>{integer.format(record.outputTokens)}</td><td>{integer.format(record.totalTokens)}</td>
                    <td className={css.cost}>{record.free ? t('usageFree') : money(record.cost, result.currency, 6)}</td>
                  </tr>
                })}
              </tbody>
            </table></div>}
          {records !== undefined && <div className={css.pagination}>
            <span className={css.secondary}>{t('usageRecordRange', { start, end, total: records.total })}</span>
            <span className={css.secondary}>{t('usagePageStatus', { page: records.page, pages })}</span>
            <div className={css.pageActions}>
              <Button type="button" variant="outline" disabled={state.phase === 'loading' || records.page <= 1}
                onClick={() => { setQuery(previous => ({ ...previous, page: previous.page - 1 })) }}>{t('usagePreviousPage')}</Button>
              <Button type="button" variant="outline" disabled={state.phase === 'loading' || records.page >= pages}
                onClick={() => { setQuery(previous => ({ ...previous, page: previous.page + 1 })) }}>{t('usageNextPage')}</Button>
            </div>
          </div>}
        </div>
      </>}
    </section>
  )
}

/** @param value - backend UTC timestamp. @param locale - display locale. @returns local date and time to seconds. */
function formatTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value))
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className={css.stat}>
      <span className={css.secondary}>{label}</span>
      <strong className={css.value}>{value}</strong>
      {note !== undefined && <span className={css.secondary}>{note}</span>}
    </div>
  )
}

export type { RelayAccountKey }
