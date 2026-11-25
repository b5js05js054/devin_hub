/** Mutation feedback shared by the General settings row and its shell toast. */
import { defineStore } from '@deepseek-ai/dsh-client-store'

type SavePhase = 'idle' | 'saving' | 'saved' | 'failed'

/**
 * Keep the pending write and its outcome visible across settings panel remounts.
 * @returns the root-scoped feedback store shared by both entries.
 */
export function createUserPromptSaveStore() {
  return defineStore({
    init: (): { phase: SavePhase } => ({ phase: 'idle' }),
    actions: {
      setPhase(state, phase: SavePhase) { state.phase = phase },
    },
  })
}
