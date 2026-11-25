import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, MessageSource, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import * as conversation from '../src/index.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'test-guest': { readonly kind: 'test-guest'; readonly guest: string }
  }
}

const route = { provider: 'mock', model: 'mock' }
const preference = '  Prefer short answers.\n请保留示例。  '
const owned = new Set<Context>()

afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
})

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly callToolFirst: boolean) { super() }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.callToolFirst && this.requests.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('check-1'), name: 'check', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function setup(callToolFirst = false) {
  const ctx = new Context()
  owned.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  const config = await liveConfig(ctx, conversation, { userPrompt: preference })
  const adapter = new RecordingAdapter(callToolFirst)
  ctx.llm.registerAdapter(['mock'], adapter)
  if (callToolFirst) ctx.tools.register(defineContentToolFixture({
    name: 'check', description: 'Check the supplied input.', parameters: {},
    async execute() { return [{ type: 'text', text: 'checked' }] },
  }))
  const agent = await loop.create(SessionId('conversation'), route)
  return { ctx, agent, config, requests: adapter.requests }
}

function ownerSource(id: string): MessageSource {
  return { kind: 'user', rpcId: id as SessionRequestId, clientTimeZone: 'Asia/Shanghai' }
}

function input(text: string, source: MessageSource = ownerSource(text)): UserMessage {
  return createUserMessage({ source, content: [{ type: 'text', text }] })
}

async function send(agent: Agent, message: UserMessage) {
  agent.followup(message)
  await agent.whenIdle()
}

describe('saved user prompt at model input', () => {
  it('admits the preference next to the original GUI message once across a tool turn', async () => {
    const { ctx, agent, requests } = await setup(true)
    ctx.on('agent/pre-step', async (_proposal, next) => {
      const decision = await next()
      return decision.kind === 'enter' ? { ...decision, startsRequestSeries: true } : decision
    })
    const human = createUserMessage({
      source: ownerSource('upload'),
      content: [
        { type: 'text', text: '  Review this.\n第二行  ' },
        { type: 'image', attachment: { attachmentId: AttachmentId('image-1'), mediaType: 'image/png', width: 3, height: 2, bytes: 100 } },
      ],
    })
    await send(agent, human)

    expect(requests).toHaveLength(2)
    const logged = agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' ? [event.data] : [])
    expect(logged).toHaveLength(2)
    expect(logged[0]).toMatchObject({
      role: 'user', source: { kind: 'user-prompt', form: 'instructions' },
      content: [{ type: 'text', text: preference }],
    })
    expect(logged[0]!.id).toBeTypeOf('string')
    expect(logged[0]!.id).not.toBe(human.id)
    expect(logged[1]).toEqual(human)
    for (const request of requests) {
      expect(request.messages.filter(message => message.source?.kind === 'user-prompt')).toEqual([logged[0]])
      const at = request.messages.findIndex(message => message.id === human.id)
      expect(request.messages.slice(at - 1, at + 1)).toEqual(logged)
      expect(JSON.stringify(request.messages.filter(message => message.role !== 'user'))).not.toContain('Prefer short answers.')
    }
    expect(requests[1]!.messages.some(message => message.role === 'tool')).toBe(true)
    expect(agent.session.snapshotEvents().find(event => event.type === 'request/header')?.data).toMatchObject({ startsSeries: true })
  })

  it('uses the latest settings for each new input and keeps older messages as recorded', async () => {
    const { agent, config } = await setup()
    const changes = ['First\n第二行', ' \t\n ', 'Changed', '']
    for (const [i, userPrompt] of changes.entries()) {
      await config.update({ userPrompt })
      await send(agent, input(`human ${String(i)}`))
    }
    await config.update({ userPrompt: 'Configured before unload' })
    await config.fiber.dispose()
    await send(agent, input('after unload'))
    const history = agent.session.deriveMessages().filter(message => message.role === 'user')
    expect(history.map(message => [message.source.kind, message.content[0]])).toEqual([
      ['user-prompt', { type: 'text', text: 'First\n第二行' }],
      ['user', { type: 'text', text: 'human 0' }],
      ['user', { type: 'text', text: 'human 1' }],
      ['user-prompt', { type: 'text', text: 'Changed' }],
      ['user', { type: 'text', text: 'human 2' }],
      ['user', { type: 'text', text: 'human 3' }],
      ['user', { type: 'text', text: 'after unload' }],
    ])
  })

  it('accepts owner input when the Host is mounted directly without config', async () => {
    const { ctx, agent, config, requests } = await setup()
    await config.fiber.dispose()
    await ctx.plugin((child) => { conversation.apply(child) })
    const human = input('direct host')
    await send(agent, human)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.messages.filter(message => message.role === 'user')).toEqual([human])
  })

  it('limits new preferences to owner GUI submissions in ordinary sessions', async () => {
    const { ctx, agent, requests } = await setup()
    const remote = input('guest', { kind: 'user', rpcId: 'guest' as SessionRequestId, principal: { kind: 'test-guest', guest: 'outside' } })
    const background = input('background', { kind: 'user' })
    const notice = input('automatic context', { kind: 'model-selection' })
    for (const item of [remote, background, notice]) await send(agent, item)
    const children = [
      { id: 'subagent-origin', meta: { origin: 'subagent' as const } },
      { id: 'resumed-delegate', meta: { delegationDepth: 1 } },
      { id: 'live-child', parentAgent: agent },
    ]
    for (const { id, ...ownership } of children) {
      const { agent: child } = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: route, ...ownership })
      await send(child, input('owner steering a child'))
    }
    expect(requests).toHaveLength(6)
    for (const request of requests) expect(JSON.stringify(request.messages)).not.toContain('Prefer short answers.')
    await send(agent, input('owner in the main session'))
    expect(requests.at(-1)!.messages.at(-2)?.source?.kind).toBe('user-prompt')
  })

  it('retains the parent history and applies the current prompt to new owner input in an ordinary fork', async () => {
    const { ctx, agent, config, requests } = await setup()
    await send(agent, input('parent input'))
    const events = agent.session.snapshotEvents()
    const boundary = events.findLast(event => event.type === 'turn/end')!.seq
    const { agent: fork } = await ctx.agents.create({
      sessionId: SessionId('fork'), agentOptions: route,
      meta: { parentSession: agent.id, isSeeded: true },
      seed: buildForkSeed(events, boundary), inheritedEventCount: SessionLogOffset(boundary + 1),
    })
    await config.update({ userPrompt: 'Use a table.' })
    await send(fork, input('fork input'))
    const prompts = requests.at(-1)!.messages.filter(message => message.source?.kind === 'user-prompt')
    expect(prompts.map(message => message.content)).toEqual([
      [{ type: 'text', text: preference }], [{ type: 'text', text: 'Use a table.' }],
    ])
    expect(prompts[0]).toEqual(requests[0]!.messages.find(message => message.source?.kind === 'user-prompt'))
  })

  it('decorates only claimed inputs retained by admission, preserving rewritten inputs and surrounding context', async () => {
    const { ctx, agent } = await setup()
    const proposed = input('submitted')
    const rewritten = { ...proposed, content: [{ type: 'text' as const, text: 'rewritten by a listener' }] }
    const replayed = input('replayed historical RPC')
    const other = input('second steering')
    const event = { messages: [proposed, other], turn: 1, step: 2, signal: new AbortController().signal }
    const emit = agentEvents(ctx, agent)
    const decision = await emit.waterfall('agent/pre-step', event, async () => ({
      kind: 'enter' as const, startsRequestSeries: true as const, messages: [replayed, rewritten, other],
    }))
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('inputs were rejected')
    expect(decision.startsRequestSeries).toBe(true)
    expect(decision.messages.map(message => message.source.kind)).toEqual(['user', 'user-prompt', 'user', 'user-prompt', 'user'])
    expect(decision.messages[0]).toBe(replayed)
    expect(decision.messages[2]).toBe(rewritten)
    expect(decision.messages[4]).toBe(other)
    expect(decision.messages[1]!.id).not.toBe(decision.messages[3]!.id)
    const removed = { kind: 'enter' as const, messages: [replayed] }
    expect(await emit.waterfall('agent/pre-step', event, async () => removed)).toBe(removed)
    const rejected = { kind: 'reject' as const }
    expect(await emit.waterfall('agent/pre-step', event, async () => rejected)).toBe(rejected)
    const accepted = { kind: 'enter' as const, messages: [proposed] }
    expect(await emit.waterfall('agent/pre-step', { ...event, signal: AbortSignal.abort() }, async () => accepted)).toBe(accepted)
  })
})
