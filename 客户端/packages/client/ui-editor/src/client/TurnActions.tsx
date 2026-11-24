import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-deliverables/client'

/** Outcome recorded per reviewed turn. */
export type TurnReview = 'busy' | 'accepted' | 'rejected' | { readonly failed: string; readonly partial: boolean }

/** Inject face of the whole-turn review buttons. */
export interface TurnActionsInjected {
  readonly hooks: {
    readonly ideActive: HostObservable<boolean>
    readonly turnReviews: HostObservable<Readonly<Record<string, TurnReview | undefined>>>
  }
  readonly accept: (sessionId: SessionId, key: string, files: Owner['files']) => void
  readonly reject: (sessionId: SessionId, key: string, files: Owner['files'], readDiff: Owner['readDiff']) => void
}

type Props = PropsRuntime<'deliverables.changes.actions'> & PropsLocale<'ide'> & InjectFace<TurnActionsInjected>
type Owner = SlotMap['deliverables.changes.actions']['owner']

/**
 * Accept-all and reject-all for one turn's changed files, shown only while the IDE panel is the main panel.
 * @param props - the turn's owner data, review state and callbacks.
 * @returns the buttons, the recorded outcome, or nothing outside the IDE.
 */
export function TurnActions({ t, sessionId, seq, files, readDiff, useIdeActive, useTurnReviews, accept, reject }: Props): ReactNode {
  const active = useIdeActive(value => value)
  const key = `${sessionId}:${seq}`
  const review = useTurnReviews(value => value[key])
  if (!active) return null
  if (review === 'accepted' || review === 'rejected') return <span>{t(review === 'accepted' ? 'turnAccepted' : 'turnRejected')}</span>
  const busy = review === 'busy'
  return <>
    {typeof review === 'object' && <span role="alert">{t(review.partial ? 'turnRejectPartial' : 'turnRejectFailed', { name: review.failed })}</span>}
    <Button size="sm" disabled={busy} onClick={() => { accept(sessionId, key, files) }}>{t('acceptAll')}</Button>
    <Button size="sm" disabled={busy} onClick={() => { reject(sessionId, key, files, readDiff) }}>{t('rejectAll')}</Button>
  </>
}
