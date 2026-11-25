/** General Settings editor for the user prompt sent with chat messages. */
import { useId, useState } from 'react'
import type { ObservableSnapshot, PropsStore } from '@deepseek-ai/dsh-client-store'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigFormSnapshot, SettingsMirrorSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationSettings } from '../../submission-settings.ts'
import type { ConversationKey } from '../locales.ts'
import type { createUserPromptSaveStore } from './user-prompt-save.ts'
import row from './EnterBehaviorRow.module.css'
import css from './UserPromptRow.module.css'

/** Accepted Host settings and the explicit actions available to this row. */
export interface UserPromptRowInjected {
  hooks: {
    promptSettings: ObservableSnapshot<ConfigFormSnapshot<ConversationSettings>>
    settingsRead: ObservableSnapshot<SettingsMirrorSnapshot>
  }
  saveUserPrompt(text: string): Promise<boolean>
  retryRead(): Promise<void>
}

type SaveFeedback = PropsStore<ReturnType<typeof createUserPromptSaveStore>> & PropsLocale<'conversation'>
type RowProps = PropsRuntime<'settings.general.item'> & InjectFace<UserPromptRowInjected> & SaveFeedback

/**
 * Stage text locally until Save. A pristine editor follows the current Host value.
 * @param props - Host settings, save feedback and translated row copy.
 * @returns the labelled multiline editor and its save action.
 */
export function UserPromptRow({ usePromptSettings, useSettingsRead, saveUserPrompt, retryRead, useStore, actions, t }: RowProps) {
  const id = useId()
  const { status, value, writable } = usePromptSettings(state => state)
  const readFailed = useSettingsRead(state => state.status === 'idle' && state.error !== null)
  const saving = useStore(state => state.phase === 'saving')
  const [draft, setDraft] = useState<string>()
  const saved = value?.userPrompt ?? ''
  const disabled = status !== 'ready' || !writable
  let notice: ConversationKey | undefined
  if (status === 'loading') notice = readFailed ? 'settings.prompt.readFailed' : 'settings.prompt.loading'
  else if (status === 'unavailable') notice = 'settings.prompt.unavailable'
  else if (!writable) notice = 'settings.prompt.readOnly'

  async function save(text: string): Promise<void> {
    actions.setPhase('saving')
    const accepted = await saveUserPrompt(text).catch(() => false)
    if (accepted) setDraft(undefined)
    actions.setPhase(accepted ? 'saved' : 'failed')
  }

  return (
    <div className={row.row}>
      <div className={css.content}>
        <label htmlFor={id} className={row.title}>{t('settings.prompt.title')}</label>
        <div id={`${id}-hint`} className={row.desc}>{t('settings.prompt.description')}</div>
        <textarea
          id={id}
          aria-describedby={`${id}-hint`}
          className={css.input}
          rows={3}
          value={draft ?? saved}
          disabled={disabled}
          readOnly={saving}
          onChange={(event) => { setDraft(event.target.value === saved ? undefined : event.target.value) }}
        />
        <div className={css.actions}>
          <span className={row.desc} role="status">{notice && t(notice)}</span>
          {notice === 'settings.prompt.readFailed' && (
            <Button size="sm" variant="outline" onClick={() => { void retryRead() }}>{t('settings.prompt.retry')}</Button>
          )}
          <Button
            size="sm" variant="primary"
            disabled={disabled || saving || draft === undefined || draft === saved}
            onClick={() => { if (draft !== undefined) void save(draft) }}
          >
            {t(saving ? 'settings.prompt.saving' : 'settings.prompt.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Announce the write result even when the user has closed Settings.
 * @param props - shared mutation feedback and localized copy.
 * @returns the shell toast while a save result is visible.
 */
export function UserPromptToast({ useStore, actions, t }: PropsRuntime<'shell.overlay'> & SaveFeedback) {
  const phase = useStore(state => state.phase)
  if (phase !== 'saved' && phase !== 'failed') return null
  return <Toast key={phase} text={t(phase === 'saved' ? 'settings.prompt.saved' : 'settings.prompt.saveFailed')}
    {...phase === 'saved' ? { tone: 'success' as const } : {}} onDone={() => { actions.setPhase('idle') }} />
}
