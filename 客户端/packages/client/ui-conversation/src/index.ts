/** Host registration for browser conversation preferences. */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId, MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import {
  BUSY_ENTER_FIELD, ConversationSettingsFields, USER_PROMPT_FIELD, type BusyEnterBehavior,
} from './submission-settings.ts'

export {
  BUSY_ENTER_BEHAVIORS, BUSY_ENTER_FIELD, CONVERSATION_SETTINGS_NAMESPACE,
  DEFAULT_BUSY_ENTER_BEHAVIOR, USER_PROMPT_FIELD, type BusyEnterBehavior, type ConversationSettings,
} from './submission-settings.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Owner preferences accompanying an admitted GUI prompt. */
    'user-prompt': { kind: 'user-prompt'; form: 'instructions' }
  }
}

/** Host-backed preferences for GUI conversations. */
export interface Config {
  /** Enter key behavior while a turn is running. */
  busyEnter: Volatile<BusyEnterBehavior>
  /** Owner's default instructions, sampled when a new GUI prompt enters a step. */
  userPrompt: Volatile<string>
}

/** Live conversation preferences. */
export const Config = z.object({
  [BUSY_ENTER_FIELD]: ConversationSettingsFields[BUSY_ENTER_FIELD].volatile(),
  [USER_PROMPT_FIELD]: ConversationSettingsFields[USER_PROMPT_FIELD].volatile(),
})

function isOwnerPrompt(source: MessageSource): boolean {
  return source.kind === 'user' && 'rpcId' in source && typeof source.rpcId === 'string' && !('principal' in source)
}

function preferenceFor(id: MessageId, prompt: string): UserMessage {
  return {
    id: brandString<MessageId>(`user-prompt:${id}`),
    role: 'user',
    source: { kind: 'user-prompt', form: 'instructions' },
    content: [{ type: 'text', text: prompt }],
  }
}

/** Register the settings form and attach the owner's preference to admitted human input.
 * @param ctx Plugin context owning the settings and pre-step listeners.
 * @param config Live configuration supplied by Cordis. Direct mounts may omit it for the empty default.
 */
export function apply(ctx: Context, config?: Config): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  if (config === undefined) return
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || !messages.length) return decision
    const prompt = config.userPrompt.get()
    if (!prompt.trim()) return decision
    const claimed = new Set(messages.filter(message => isOwnerPrompt(message.source)).map(message => message.id))
    if (!claimed.size) return decision
    const { origin, delegationDepth } = agent.session.header
    if (origin === 'subagent' || (delegationDepth ?? 0) > 0 || !ctx.get('agents')?.roots().includes(agent)) return decision
    const admitted = decision.messages.flatMap(message => isOwnerPrompt(message.source) && claimed.delete(message.id)
      ? [preferenceFor(message.id, prompt), message]
      : [message])
    return admitted.length === decision.messages.length ? decision : { ...decision, messages: admitted }
  }, { prepend: true })
}
