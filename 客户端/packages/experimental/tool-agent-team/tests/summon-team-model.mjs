/** Keyless model for the bundled summon / Agent Teams profile regression. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

function* textResponse(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function* toolCallResponse(id, name, args) {
  const serialized = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: serialized }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: serialized } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

class TeamExpertModel extends LlmAdapter {
  followup = Promise.withResolvers()
  async * stream({ messages, tools }) {
    const result = messages.findLast(message => message.role === 'tool')
    const text = result?.content.map(block => block.text).join('')
    const raw = messages.flatMap(message => message.role === 'user' && message.source.kind === 'user' ? message.content : [])
    const expert = raw.some(block => block.text?.includes('Read the Team board as reviewer.'))
    const names = tools.map(tool => tool.name)
    if (expert) {
      if (!names.includes('team_task_list')) yield* textResponse('The expert preset has no team_task_list.')
      else if (raw.some(block => block.text?.includes('LEAD_PRIVATE_HISTORY'))) yield* textResponse('Fresh expert saw lead history.')
      else if (messages.some(message => message.source.kind === 'agent-message' && message.content.some(block => block.text === 'Include the orange checklist.'))) {
        this.followup.resolve('Reviewer received the orange checklist.')
        yield* textResponse('I will include it.')
      } else if (!result) yield* toolCallResponse('reviewer-read', 'team_task_list', {})
      else yield* textResponse(text.includes('Blue checklist') ? 'Reviewer found Blue checklist.' : 'Reviewer could not read the root board: ' + text)
    } else if (!result) {
      yield* toolCallResponse('make-task', 'team_task_create', { subject: 'Blue checklist', description: 'Shared only via the root board.' })
    } else if (result.source.callId === 'make-task') {
      yield* toolCallResponse('ask-reviewer', 'summon_expert', { expert: 'generalist', task: 'Read the Team board as reviewer.', readOnly: true })
    } else if (result.source.callId === 'ask-reviewer' && text === 'Reviewer found Blue checklist.') {
      yield* toolCallResponse('find-reviewer', 'list_agents', {})
    } else if (result.source.callId === 'find-reviewer' && !result.isError) {
      const reviewer = JSON.parse(text).find(row => row.role === 'subagent' && row.description === 'expert:generalist')
      if (reviewer) yield* toolCallResponse('update-reviewer', 'send_message', { target: reviewer.target, message: 'Include the orange checklist.' })
      else yield* textResponse('No continuable reviewer listed: ' + text)
    } else if (result.source.callId === 'update-reviewer' && !result.isError) {
      yield* textResponse('Reviewer found Blue checklist. ' + await this.followup.promise)
    } else {
      yield* textResponse(text)
    }
  }
}

export const name = 'summon-team-model'
export const inject = ['llm']
export function apply(ctx) {
  ctx.llm.registerAdapter(['deepseek-official'], new TeamExpertModel())
}
