/** Resolve the Team whose projections and direct-child addresses the panel uses. */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * @param sessions - shared Session summaries with direct subagent ancestry.
 * @param sessionId - current conversation, or its addressed parent when known.
 * @returns the Team root, or undefined for a missing subagent parent id or a cycle.
 */
export function teamRoot(sessions: SessionListState, sessionId: SessionId): SessionId | undefined {
  const seen = new Set<SessionId>()
  let id = sessionId
  while (!seen.has(id)) {
    seen.add(id)
    const row = sessions.byId[id]
    if (row?.origin !== 'subagent') return id
    if (row.parentId === undefined) return undefined
    id = row.parentId
  }
  return undefined
}
