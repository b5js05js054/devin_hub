import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
/** Parent result delivery independent of a local child's messaging tool. */

import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Control from '@deepseek-ai/dsh-tool-subagent-control'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime, { NO_START_CAPABILITIES, type SubagentResult } from '../src/index.ts'
import { mountLocalActivations, startTestActivation } from './local-activation.ts'

it.each(['absent', 'unused'] as const)('returns the closing answer when send_message is %s', async (availability) => {
  const ctx = new Context()
  await mountLocalActivations(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  if (availability !== 'absent') await ctx.plugin(Control)
  const adapter = new MockAdapter([textResponse('CHILD_RESULT_42'), textResponse('Parent received the answer.')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  const activation = await ctx.subagents.startActivation({
    provider: 'spawn', label: 'Compute the answer', delivery: 'parent', signal: new AbortController().signal,
    request: {
      parent, prompt: [{ type: 'text', text: 'Find the answer.' }],
    },
  })
  try {
    await ctx.subagents.waitForChildren(parent)
    await parent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]!.tools?.some(tool => tool.name === 'send_message') ?? false).toBe(availability === 'unused')
    const notices = adapter.requests[1]!.messages.filter(message => message.source?.kind === 'subagent-settled')
    expect(notices).toHaveLength(1)
    expect(JSON.stringify(notices)).toContain('CHILD_RESULT_42')
    expect(JSON.stringify(notices)).toContain('Its closing message:')
  } finally {
    await activation.dispose()
  }
})

it.each(['parent', 'caller'] as const)('routes a closing subagent settlement once with delivery=%s', async (delivery) => {
  const ctx = new Context()
  await mountLocalActivations(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  const adapter = new MockAdapter([textResponse('waiting'), textResponse('received the child result')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  const output = [{ type: 'text' as const, text: 'Reviewed the patch.' }]
  const result = Promise.withResolvers<SubagentResult>()
  const cleaning = Promise.withResolvers<void>()
  const cleaned = Promise.withResolvers<void>()
  ctx.subagents.registerProvider({
    name: 'reviewer', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
    start: () => Promise.resolve({
      id: SessionId('reviewer'), result: result.promise,
      dispose() { cleaning.resolve(); return cleaned.promise },
    }),
  })
  const activation = await ctx.subagents.startActivation({
    provider: 'reviewer', label: 'Review', delivery, signal: new AbortController().signal,
    request: { parent, prompt: [{ type: 'text', text: 'Review the patch.' }] },
  })
  try {
    result.resolve({ output, stopReason: 'completed' })
    await cleaning.promise
    ctx.on('session/event', (session, event) => {
      if (session === parent.session && event.type === 'turn/end' && event.data.turn === 1) cleaned.resolve()
    })
    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Check progress.' }] }))
    const idle = parent.whenIdle()
    await expect(activation.result).resolves.toEqual({ output, stopReason: 'completed' })
    await idle
    const notices = parent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled')
    if (delivery === 'parent') {
      expect(notices).toHaveLength(1)
      expect(adapter.requests).toHaveLength(2)
      const notice = adapter.requests[1]?.messages.find(message => message.source?.kind === 'subagent-settled')
      expect(notice?.source).toMatchObject({ senderSessionId: activation.childId })
      expect(notice?.content).toContainEqual(output[0])
    } else {
      expect(notices).toEqual([])
      expect(adapter.requests).toHaveLength(1)
    }
    expect(parent.inbox.nextTurn).toEqual([])
    expect(parent.inbox.nextStep).toEqual([])
  } finally {
    cleaned.resolve()
    await activation.dispose()
  }
})

it('admits a resident child message sent just after the parent turn ends', async () => {
  const ctx = new Context()
  await mountLocalActivations(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  const adapter = new MockAdapter([textResponse('waiting'), textResponse('parent received the result')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  const releaseChild = Promise.withResolvers<void>()
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent !== parent) await releaseChild.promise
    return next()
  })
  const activation = await startTestActivation(ctx, 'spawn', {
    parent, prompt: [{ type: 'text', text: 'Review this.' }],
  })
  try {
    const ended = Promise.withResolvers<void>()
    ctx.on('session/event', (session, event) => {
      if (session === parent.session && event.type === 'turn/end' && event.data.turn === 1) ended.resolve()
    })
    const content = [{ type: 'text' as const, text: 'The child finished its review.' }]
    const receipt = ended.promise.then(() => ctx.subagents.sendMessage(
      activation.localAgent, parent.id, content, { signal: new AbortController().signal },
    ))
    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Check progress.' }] }))
    const idle = parent.whenIdle()
    const id = await receipt
    await idle
    expect(adapter.requests).toHaveLength(2)
    const delivered = adapter.requests[1]?.messages.filter(message => message.id === id)
    expect(delivered).toHaveLength(1)
    expect(delivered?.[0]?.content).toContainEqual(content[0])
    expect(parent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === id)).toHaveLength(1)
  } finally {
    releaseChild.resolve()
    await activation.dispose()
  }
})

it('delivers structured output to the parent when the child has send_message', async () => {
  const ctx = new Context()
  await mountLocalActivations(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(Control)
  const adapter = new MockAdapter([
    toolCallResponse('structured-answer', 'structured_output', { answer: 42 }),
    textResponse('Parent received the structured answer.'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  const activation = await ctx.subagents.startActivation({
    provider: 'spawn', label: 'Compute the answer', delivery: 'parent', signal: new AbortController().signal,
    request: {
      parent, prompt: [{ type: 'text', text: 'Find the answer.' }],
      outputSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
    },
  })
  try {
    await activation.result
    await parent.whenIdle()
    expect(adapter.requests[0]!.tools?.some(tool => tool.name === 'send_message')).toBe(true)
    const notices = adapter.requests[1]!.messages.filter(message => message.role === 'user')
    expect(notices.flatMap(message => message.content)).toContainEqual({ type: 'text', text: 'Structured result: {"answer":42}' })
    expect(JSON.stringify(notices)).not.toContain('Its closing message:')
  } finally {
    await activation.dispose()
  }
})
