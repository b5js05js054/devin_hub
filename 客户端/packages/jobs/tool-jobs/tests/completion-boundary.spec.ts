/** Job settlements racing the owning Agent's last step. */
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { expect, it, onTestFinished } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createTestContext } from '../../../core/agent-loop/tests/test-context.ts'

async function setup(config: ToolJobs.Config = {}) {
  const adapter = new MockAdapter([textResponse('waiting'), textResponse('received'), textResponse('resumed')])
  const ctx = await createTestContext(adapter)
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolJobs, config)
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })

  // Like a background tool, the producer translates its result into a job outcome.
  // The registry then commits that outcome and delivers its own settlement event.
  function finishAtStepEnd(turn: number) {
    const answer = Promise.withResolvers<string>()
    const id = ctx.jobs.start({
      kind: 'bash', label: 'review', owner: owner.id,
      run: () => ({
        done: answer.promise.then(result => ({ status: 'completed', result })),
        cancel: () => answer.resolve('cancelled'),
      }),
    })
    ctx.on('session/event', (session, event) => {
      if (session === owner.session && event.type === 'step/end' && event.data.turn === turn && event.data.step === 1) {
        answer.resolve('review finished')
      }
    })
    return id
  }
  function prompt(text: string) {
    owner.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    return owner.whenIdle()
  }
  const notices = () => owner.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'tool-jobs')
  return { ctx, owner, adapter, finishAtStepEnd, prompt, notices }
}

it.each([undefined, 'wakeup'] as const)('delivers the closing completion once with completionDelivery=%s', async (delivery) => {
  const h = await setup(delivery === undefined ? {} : { completionDelivery: delivery })
  const id = h.finishAtStepEnd(1)
  await h.prompt('start')

  expect(h.ctx.jobs.list(h.owner.id)).toMatchObject([{ id, status: 'completed' }])
  expect(h.adapter.requests).toHaveLength(2)
  expect(h.adapter.requests[1]?.messages.filter(message => message.source?.kind === 'tool-jobs')).toHaveLength(1)
  expect(h.notices()).toHaveLength(1)
  expect(h.owner.inbox.nextStep).toEqual([])
  expect(h.owner.inbox.nextTurn).toEqual([])
})

it('keeps a quiet closing completion for the next waking input', async () => {
  const h = await setup({ completionDelivery: 'quiet' })
  h.finishAtStepEnd(1)
  await h.prompt('start')
  expect(h.adapter.requests).toHaveLength(1)
  expect(h.owner.inbox.nextStep.map(message => message.source.kind)).toEqual(['tool-jobs'])

  await h.prompt('collect it')
  expect(h.adapter.requests).toHaveLength(2)
  expect(h.notices()).toHaveLength(1)
})

it('charges a wake after the last step and parks the next closing completion at the cap', async () => {
  const h = await setup({ maxConsecutiveWakes: 1 })
  h.finishAtStepEnd(1)
  const second = h.finishAtStepEnd(2)
  await h.prompt('start')

  expect(h.adapter.requests).toHaveLength(2)
  expect(h.notices()).toHaveLength(1)
  expect(h.ctx.jobs.list(h.owner.id)).toContainEqual(expect.objectContaining({ id: second, status: 'completed' }))
  expect(h.owner.inbox.nextStep.map(message => message.source.kind)).toEqual(['tool-jobs'])

  await h.prompt('collect the second result')
  expect(h.adapter.requests).toHaveLength(3)
  expect(h.notices()).toHaveLength(2)
})
