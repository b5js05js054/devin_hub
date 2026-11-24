/** Background image settings registration: local storage, page effects, and the global stylesheet. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import background from '../styles/background.css?inline'
import { BackgroundSection, type BackgroundInjected } from './BackgroundSection.tsx'
import { downscaleImage, openIndexedDbStorage } from './browser.ts'
import { BackgroundController } from './controller.ts'
import { en, zh, type BackgroundImageKey } from './locales.ts'
export type { BackgroundInjected, BackgroundSectionProps } from './BackgroundSection.tsx'
export type { BackgroundImageKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.background-image': BackgroundImageKey }
}

const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-background-image'

/** Services required by background image settings. */
export const inject = ['slots', 'locale']
/** Register the background image section. @param ctx - client plugin context. */
export function apply(ctx: Context): void {
  if (typeof document === 'undefined') return
  ctx.effect(() => ctx.locale.register('settings.background-image', { en, zh }), 'background-image: dictionaries')
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = `${PLUGIN_ID}/background.css`
    tag.textContent = background
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'background-image: stylesheet')
  const t = ctx.locale.bind('settings.background-image')
  const { storage, close } = openIndexedDbStorage()
  const controller = new BackgroundController({
    storage, target: document.body, prepare: downscaleImage,
    createObjectUrl: blob => URL.createObjectURL(blob), revokeObjectUrl: (url) => { URL.revokeObjectURL(url) },
  })
  ctx.effect(() => () => { controller.dispose(); close() }, 'background-image: page effects')
  void controller.restore()
  const operations: BackgroundInjected = {
    hooks: { background: { getSnapshot: controller.getSnapshot, subscribe: controller.subscribe } },
    choose: file => controller.choose(file),
    clear: () => controller.clear(),
    setOpacity: percent => controller.setOpacity(percent),
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'background-image', order: -7, label: () => t('title'),
    locale: 'settings.background-image', inject: () => operations,
  }, BackgroundSection))
}
