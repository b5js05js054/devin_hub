/** Media parameter panel registration at the composer's `conversation.input.media` seat. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { MediaParamsPanel, type MediaParamsInjected } from './MediaParamsPanel.tsx'
import { en, zh, type MediaParamsKey } from './locales.ts'
export type { MediaParamsInjected, MediaParamsPanelProps } from './MediaParamsPanel.tsx'
export type { MediaParamsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'media-params': MediaParamsKey }
}

/** Services required by the media parameter panel. */
export const inject = ['slots', 'locale', 'remote', 'remote.media', 'modelDirectories']
/** Register the panel. @param ctx - client plugin context. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('media-params', { en, zh }), 'ui-media-params: dictionaries')
  ctx.inject(['slots', 'modelDirectories'], (scope: Context) => {
    scope.slots.inject('conversation.input.media', () => scope.slots.register({
      name: 'conversation.input.media',
      id: 'media-params',
      locale: 'media-params',
      inject: (sessionId): MediaParamsInjected => ({
        hooks: { directory: scope.modelDirectories.directoryFor(sessionId).store },
        getSpec: async (model) => {
          const result = await scope.remote.media.getSpec(model)
          return result.ok ? result.value : { ok: false, code: 'unavailable', message: '' }
        },
        setParams: async (model, params) => { await scope.remote.media.setParams(String(sessionId), model, params) },
      }),
    }, MediaParamsPanel))
  })
}
