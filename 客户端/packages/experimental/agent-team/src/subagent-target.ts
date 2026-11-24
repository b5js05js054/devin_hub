/** Exact Team-tool addresses for local subagent Sessions. */

import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Format the same stable target for roster discovery, messaging and task ownership.
 * @param id - local subagent Session identity.
 * @returns the model-facing address.
 */
export function subagentTarget(id: SessionId): string {
  return `subagent:${id}`
}
