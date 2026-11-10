/** Browser half: the IDE main panel (file tree, Monaco editor with Agent-edit review, embedded conversation). */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-api-workspace-files/types'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { isAbsoluteWorkspacePath, parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { ideFace } from './face.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { TurnActions, type TurnActionsInjected, type TurnReview } from './TurnActions.tsx'
import { rejectTurn, turnPath } from './turn-review.ts'
import { agentTabs } from './agents.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    ideTabs: unknown
  }
}
import { IdeMain, IdePage, type IdeFace } from './IdePage.tsx'
import { en, zh, type EditorLocaleKey } from './locales.ts'
import { IdePanelIcon } from './PanelIcon.tsx'
import { createIdeStore } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    ide: EditorLocaleKey
  }

  interface SlotMap {
    /** The IDE workspace of the current Session beneath the root-scoped main panel. */
    'ide.workspace': { kind: 'single'; scope: 'session' }
    /** One extra Agent conversation, bound to its own Session. */
    'ide.agent': { kind: 'single'; scope: 'session' }
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'ide'

/** The id shared by the sidebar entry and the main panel it opens. */
const PANEL_ID = 'ide' as MainPanelId

/** Services this plugin reads. */
export const inject = ['slots', 'locale', 'remote', 'remote.workspaceFiles', 'remote.session', 'layout', 'theme', 'sessions', 'workspaces', 'sidebarRight']

/**
 * Contribute the IDE entry to the sidebar with the panel it opens.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-editor: dictionaries')
  const t = ctx.locale.bind(NS)
  const faces = new Map<SessionId, IdeFace>()
  const theme: IdeFace['hooks']['theme'] = {
    getSnapshot: () => ctx.theme.getTheme(),
    subscribe: listener => ctx.on('theme/change', listener),
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    children: { 'ide.workspace': { kind: 'single', scope: 'session' } },
  }, IdeMain))
  ctx.slots.inject('ide.workspace', () => ctx.slots.register({
    name: 'ide.workspace',
    locale: NS,
    children: { 'ide.agent': { kind: 'single', scope: 'session' } },
    store: createIdeStore,
    inject: (sessionId, actions): IdeFace => {
      const tabs = agentTabs(ctx, sessionId, actions)
      const face: IdeFace = {
        ...ideFace(ctx.remote, sessionId, actions),
        mentionFiles: (id, files) => ctx.get('conversation')?.input.mentionFiles(id as SessionId, files) ?? false,
        revealPath: async (path) => {
          try {
            return (await ctx.remote.session.openWorkspacePath({ path, action: 'reveal' })).ok
          } catch {
            // A Host that cannot be reached fails the gesture like one that refused it; the tree announces both.
            return false
          }
        },
        newAgent: tabs.newAgent,
        closeAgent: tabs.closeAgent,
        hooks: { theme, agents: tabs.agents },
      }
      faces.set(sessionId, face)
      return face
    },
  }, IdePage))
  ctx.effect(() => ctx.sidebarRight.registerFallbackOpener((address) => {
    if (ctx.layout.panelInfo.getSnapshot().activePanelId !== PANEL_ID) return false
    const file = parseFileAddress(address)
    if (file === undefined) return false
    const owner = file.scope === 'session' && faces.has(file.sessionId as SessionId) ? file.sessionId as SessionId : [...faces.keys()].at(-1)
    const face = owner === undefined ? undefined : faces.get(owner)
    if (owner === undefined || face === undefined) return false
    const cwd = ctx.sessions.list.getSnapshot().byId[owner]?.cwd
    const full = file.scope === 'session' && !isAbsoluteWorkspacePath(file.path) && cwd !== undefined
      ? `${cwd.replace(/[/\\]+$/, '')}/${file.path}`
      : file.path
    face.openFile(full, full.slice(full.lastIndexOf('/') + 1))
    return true
  }), 'ui-editor: file opener')
  const reviews = createSnapshotStore<Record<string, TurnReview | undefined>>({})
  const setReview = (key: string, value: TurnReview): void => { reviews.update((state) => { state[key] = value }) }
  const ideActive: TurnActionsInjected['hooks']['ideActive'] = {
    getSnapshot: () => ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL_ID,
    subscribe: listener => ctx.layout.panelInfo.subscribe(listener),
  }
  ctx.slots.inject('deliverables.changes.actions', () => ctx.slots.register({
    name: 'deliverables.changes.actions',
    id: 'ide-turn-review',
    locale: NS,
    inject: (): TurnActionsInjected => ({
      hooks: { ideActive, turnReviews: reviews },
      accept: (sessionId, key, files) => {
        const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
        faces.get(sessionId)?.acceptPaths(files.map(file => turnPath(cwd, file.path)))
        setReview(key, 'accepted')
      },
      reject: (sessionId, key, files, readDiff) => {
        setReview(key, 'busy')
        const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
        void rejectTurn(ctx.remote, sessionId, cwd, files, readDiff).then((result) => {
          if ('failed' in result) {
            for (const file of result.written) faces.get(sessionId)?.rebase(file.path, file.text)
            setReview(key, { failed: result.failed, partial: result.written.length > 0 })
            return
          }
          for (const file of result.restored) faces.get(sessionId)?.rebase(file.path, file.text)
          setReview(key, 'rejected')
        })
      },
    }),
  }, TurnActions))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 1,
    label: () => t('panel'),
    locale: NS,
  }, IdePanelIcon))
}
