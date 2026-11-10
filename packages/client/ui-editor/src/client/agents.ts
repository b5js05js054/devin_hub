/** Extra Agent conversations of one IDE Session: created, retained, and released as tabs open and close. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { IdeActions } from './face.ts'

/** Retained references by Session id, republished as a new object on every change. */
export type AgentReferences = Readonly<Record<string, SessionReference>>

/** Tab actions plus the observable the page binds as `useAgents`. */
export interface AgentTabs {
  readonly newAgent: () => void
  readonly closeAgent: (id: string) => void
  readonly agents: { getSnapshot: () => AgentReferences; subscribe: (listener: () => void) => () => void }
}

/**
 * Build the Agent-tab owner for one IDE Session.
 * @param ctx - client context carrying `sessions` and `workspaces`.
 * @param sessionId - the IDE's own Session; new conversations share its working directory.
 * @param actions - that Session's store write set.
 * @returns tab actions and the retained-reference observable.
 */
export function agentTabs(ctx: ClientContext, sessionId: SessionId, actions: IdeActions): AgentTabs {
  let references: AgentReferences = {}
  const listeners = new Set<() => void>()
  const publish = (next: AgentReferences): void => {
    references = next
    for (const listener of listeners) listener()
  }
  return {
    agents: {
      getSnapshot: () => references,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    newAgent: () => {
      const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
      void ctx.sessions.create(cwd === undefined ? {} : { cwd }).then((id) => {
        publish({ ...references, [id]: ctx.sessions.retain(id, { source: 'ideTabs' }) })
        actions.agentAdded(id)
      })
    },
    closeAgent: (id) => {
      const { [id]: reference, ...rest } = references
      reference?.release()
      publish(rest)
      actions.agentClosed(id)
      void ctx.workspaces.archiveSession(id as SessionId).catch(() => {})
    },
  }
}
