/** Relay account settings registration and reconnecting Remote subscription. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RelayView } from '@deepseek-ai/dsh-api-remotes/client'
import { RelayAccountMenu } from './RelayAccountMenu.tsx'
import { RelayAccountSection, type RelayAccountInjected, type RelaySnapshot } from './RelayAccountSection.tsx'
import { RelayUsageSection, type RelayUsageInjected } from './RelayUsageSection.tsx'
import { en, zh, type RelayAccountKey } from './locales.ts'
export type { RelayAccountInjected, RelayAccountSectionProps, RelaySnapshot } from './RelayAccountSection.tsx'
export type { RelayUsageInjected, RelayUsageSectionProps } from './RelayUsageSection.tsx'
export type { RelayAccountKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.relay-account': RelayAccountKey }
}

/** Services required by relay account settings. */
export const inject = ['slots', 'locale', 'remote', 'remote.relay']
/** Register the relay account section. @param ctx - client plugin context. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('settings.relay-account', { en, zh }), 'relay-account: dictionaries')
  const t = ctx.locale.bind('settings.relay-account')
  let snapshot: RelaySnapshot = { view: undefined, failed: false }
  const listeners = new Set<() => void>()
  const publish = (value: RelaySnapshot) => { snapshot = value; for (const listener of listeners) listener() }
  const stream = ctx.remote.$stream<RelayView>({
    name: 'relay', open: signal => ctx.remote.relay.watch(signal), ended: () => new Error('relay stream ended'),
  })
  let disposed = false
  ctx.effect(() => () => { disposed = true; return stream.dispose() }, 'relay-account: state stream')
  void (async () => {
    for await (const frame of stream) {
      publish({ view: frame.value, failed: false })
      frame.accept()
    }
  })().catch(() => { if (!disposed) publish({ ...snapshot, failed: true }) })
  /** @returns the Remote value, or throws the Remote failure. */
  const unwrap = async <T>(call: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>): Promise<T> => {
    const result = await call
    if (result.ok) return result.value
    throw result.error
  }
  const operations: RelayAccountInjected = {
    hooks: {
      relay: {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
    },
    startSignIn: () => unwrap(ctx.remote.relay.startSignIn()),
    cancelSignIn: () => unwrap(ctx.remote.relay.cancelSignIn()),
    logout: () => unwrap(ctx.remote.relay.logout()),
    activate: cardKey => unwrap(ctx.remote.relay.activate(cardKey)),
    redeem: code => unwrap(ctx.remote.relay.redeem(code)),
    refreshBalance: () => unwrap(ctx.remote.relay.refreshBalance()),
  }
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({
    name: 'settings.launcher', priority: -1, locale: 'settings.relay-account', inject: () => operations,
  }, RelayAccountMenu))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'relay-account', order: -9, label: () => t('nav'),
    locale: 'settings.relay-account', inject: () => operations,
  }, RelayAccountSection))
  const usage: RelayUsageInjected = { loadUsage: (days, page, pageSize) => unwrap(ctx.remote.relay.usage(days, page, pageSize)) }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'relay-usage', order: -8, label: () => t('usageNav'),
    locale: 'settings.relay-account', inject: () => usage,
  }, RelayUsageSection))
}
