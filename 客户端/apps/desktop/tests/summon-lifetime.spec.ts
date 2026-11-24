import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import { createUserMessage, ToolCallId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as JobTools from '@deepseek-ai/dsh-tool-jobs'
import { afterEach, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { mountRuntime } from '../../../packages/ptc-runtime/ptc-runtime-node/tests/setup.ts'

// Each case boots a profile and starts real Node subprocesses.
vi.setConfig({ testTimeout: 30_000 })

const pluginPath = '../bundled-plugins/bailan-expert-orchestrator/lib/index.js'
const { default: expertPlugin } = await import(pluginPath)
const dispatcherPath = '../bundled-plugins/bailan-expert-orchestrator/lib/summon-job.js'
const { createSummonDispatcher } = await import(dispatcherPath)

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() } finally { vi.unstubAllEnvs() }
})

async function setup(mode: 'native' | 'ptc' = 'ptc', parentScript?: ConstructorParameters<typeof MockAdapter>[0]) {
  const root = await mkdtemp(join(tmpdir(), 'summon-lifetime-'))
  const ctx = new Context()
  const release = Promise.withResolvers<void>()
  cleanups.push(async () => {
    release.resolve()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })
  vi.stubEnv('DSH_HOME', root)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.desktopExperts = expertPlugin
  const configFile = join(root, 'cordis.yml')
  await writeFile(configFile, '- name: cordis:desktopExperts\n  config:\n    autoClaim: false\n')
  await mountAgentLoopTestDependencies(ctx, { tools: { mode }, workingDirectory: true })
  await mountRuntime(ctx)
  await ctx.plugin(Persistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(LocalJobs)
  await ctx.plugin(JobTools, { completionDelivery: parentScript ? 'wakeup' : 'quiet' })
  const capabilities = { depthLimit: true, persona: true, toolFilter: true, agentOptions: true, agentPreset: false, outputSchema: false }
  ctx.subagents.registerProvider({ name: 'spawn', capabilities, inheritsParentContext: false, prepareContinuable: async () => ({}) })
  const model = new MockAdapter(parentScript ?? [textResponse('review finished')])
  ctx.llm.registerAdapter(['mock'], model)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  await ctx.workingDirectory.set(parent, root)
  const ends: string[] = []
  const started = Promise.withResolvers<void>()
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (agent === parent) return parentScript ? next() : { kind: 'reject' }
    started.resolve()
    const stopped = Promise.withResolvers<void>()
    const onAbort = () => stopped.resolve()
    signal.addEventListener('abort', onAbort, { once: true })
    try { await Promise.race([release.promise, stopped.promise]) } finally { signal.removeEventListener('abort', onAbort) }
    return next()
  })
  ctx.on('subagent/end', info => { ends.push(info.stopReason) })
  const ready = Promise.withResolvers<void>()
  const off = ctx.on('tools/change', () => {
    if (ctx.tools.get('summon_experts', parent)) ready.resolve()
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configFile).href } })
  await ctx.loader.await()
  await ready.promise
  off()
  const call = (code: string, timeoutMs = 10_000) => ctx.tools.execute({
    name: 'run_code', agent: parent, callId: ToolCallId('outer'), signal: new AbortController().signal,
    arguments: { description: 'Dispatch an expert', code, timeoutMs },
  })
  return { ctx, parent, model, call, release, started, ends }
}

const task = { expert: 'generalist', task: 'Review the change', readOnly: true }
const single = 'await tools.summon_expert(' + JSON.stringify(task) + ')'
const batch = 'await tools.summon_experts(' + JSON.stringify({ experts: [task, { ...task, expert: 'Missing' }] }) + ')'

it('delivers the expert answer after the dispatching program times out', async () => {
  const { ctx, parent, call, release, ends } = await setup()
  const result = await call(single + '; await new Promise(() => {})', 3000)
  expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining('execution deadline reached') })])
  const jobs = ctx.jobs.list(parent.id)
  expect(jobs).toHaveLength(1)
  const [job] = jobs
  expect(job!.status).toBe('running')
  expect(ends).toEqual([])
  release.resolve()
  await vi.waitFor(() => expect(ctx.jobs.list(parent.id)[0]?.status).toBe('completed'))
  expect(ends).toEqual(['completed'])
  expect(parent.inbox.nextStep.filter(m => m.source.kind === 'tool-jobs')).toHaveLength(1)
  const collected = await call('return await tools.job_output({ job_id: ' + JSON.stringify(job!.id) + ' })')
  expect(collected.value).toMatchObject({ result: { job: { status: 'completed' }, text: JSON.stringify({ expert: 'generalist', answer: 'review finished' }) } })
})

it('returns a team job and preserves both its answer and its per-expert error', async () => {
  const { ctx, parent, call, release } = await setup()
  const result = await call('return ' + batch)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const [job] = ctx.jobs.list(parent.id)
  expect(result.value).toMatchObject({ result: { kind: 'background', jobId: job!.id } })
  release.resolve()
  expect((await ctx.jobs.wait(job!.id, 3000, parent.id)).status).toBe('completed')
  const collected = await call('return await tools.job_output({ job_id: ' + JSON.stringify(job!.id) + ' })')
  expect(collected.value).toMatchObject({ result: { job: { status: 'completed' }, text: JSON.stringify({ results: [
    { expert: 'generalist', ok: true, answer: 'review finished' },
    { expert: 'Missing', ok: false, error: '专家不存在：Missing；可先调用 list_experts 浏览花名册（惯用名见 roster-aliases.json）' },
  ] }) } })
})

it.each([true, false])('stops a running expert when the owner kills its job (resume %s)', async resume => {
  if (!resume) vi.stubEnv('DSH_EXPERT_RESUME', '0')
  const { ctx, parent, started, call, ends } = await setup()
  const result = await call('return ' + single)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const [job] = ctx.jobs.list(parent.id)
  await started.promise
  const killed = await call('return await tools.job_kill({ job_id: ' + JSON.stringify(job!.id) + ' })')
  expect(killed.value).toMatchObject({ result: { outcome: 'cancellation-requested' } })
  expect((await ctx.jobs.wait(job!.id, 3000, parent.id)).status).toBe('killed')
  await vi.waitFor(() => expect(ends).toEqual(['aborted']))
})

it('wakes the idle parent once to collect the answer after its dispatching turn ends', async () => {
  const { ctx, parent, release, started } = await setup('ptc', [
    toolCallResponse('delegate', 'run_code', { description: 'Ask the reviewer', code: 'return ' + single }),
    textResponse('The review is running.'),
    textResponse('review finished'),
    toolCallResponse('collect', 'run_code', { description: 'Read the review', code: 'const [job] = await tools.job_list({}); return await tools.job_output({ job_id: job.id })' }),
    textResponse('The review is ready.'),
  ])
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'delegate the review' }], source: { kind: 'user' } }))
  await started.promise
  await parent.whenIdle()
  expect(ctx.jobs.list(parent.id)[0]?.status).toBe('running')
  release.resolve()
  await vi.waitFor(() => expect(parent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2))
  await parent.whenIdle()
  const results = parent.session.snapshotEvents().filter(event => event.type === 'tool/result')
  const answer = results.find(event => event.data.message.source.callId === ToolCallId('collect'))
  expect(answer?.data.message.content).toEqual([expect.objectContaining({ text: expect.stringContaining('review finished') })])
})

it('delivers a job settling at the final step boundary without another user message', async () => {
  const { ctx, parent, model } = await setup('ptc', [
    textResponse('The expert is working.'),
    toolCallResponse('collect', 'run_code', { description: 'Read the expert answer', code: 'const [job] = await tools.job_list({}); return await tools.job_output({ job_id: job.id })' }),
    textResponse('The work is ready.'),
  ])
  const answer = Promise.withResolvers<{ expert: string; answer: string }>()
  const dispatch = createSummonDispatcher(ctx)
  const receipt = dispatch({
    agent: parent, parent: 'run_code', callId: ToolCallId('nested'), rootCallId: ToolCallId('dispatch'),
    signal: new AbortController().signal,
  }, 'expert:reviewer', () => answer.promise)
  ctx.on('session/event', (session, event) => {
    if (session === parent.session && event.type === 'step/end' && event.data.turn === 1 && event.data.step === 1) {
      answer.resolve({ expert: 'reviewer', answer: 'The complete review from the closing step.' })
    }
  })
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Check the running expert.' }], source: { kind: 'user' } }))
  await parent.whenIdle()
  expect(ctx.jobs.list(parent.id)).toMatchObject([{ id: receipt.jobId, status: 'completed' }])
  expect(model.requests).toHaveLength(3)
  expect(model.requests[1]!.messages.filter(message => message.source?.kind === 'tool-jobs')).toHaveLength(1)
  expect(model.requests[2]!.messages).toContainEqual(expect.objectContaining({
    role: 'tool',
    content: [expect.objectContaining({ text: expect.stringContaining('The complete review from the closing step.') })],
  }))
  expect(parent.inbox.nextStep).toHaveLength(0)
  expect(parent.inbox.nextTurn).toHaveLength(0)
})

it('stops the delegated job when the user stops its initiating turn', async () => {
  const { ctx, parent, started, ends } = await setup('ptc', [
    toolCallResponse('delegate', 'run_code', { description: 'Ask the reviewer', code: 'return ' + single }), 'hang',
  ])
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'delegate the review' }], source: { kind: 'user' } }))
  await started.promise
  parent.cancel({ kind: 'user' })
  await vi.waitFor(() => expect(ctx.jobs.list(parent.id)[0]?.status).toBe('killed'))
  expect(ends).toEqual(['aborted'])
  await parent.whenIdle()
  expect(parent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
})

it('shows each native batch answer and failure in the next model request', async () => {
  const reviewer = { ...task, expert: 'code-reviewer', task: 'Check the types.' }
  const answer = (request: GenerateOptions) => {
    const checkTypes = request.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text.includes(reviewer.task)))
    return textResponse(checkTypes ? 'Types checked.' : 'review line one\nreview line two')
  }
  const { parent, release, model } = await setup('native', [
    toolCallResponse('batch', 'summon_experts', { experts: [task, { ...task, expert: 'Missing' }, reviewer] }),
    answer, answer, textResponse('The team has reported.'),
  ])
  release.resolve()
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Get the reviews' }], source: { kind: 'user' } }))
  await parent.whenIdle()
  const result = model.requests.at(-1)?.messages.find(message => message.role === 'tool' && message.source.callId === ToolCallId('batch'))
  expect(result?.content).toEqual([{ type: 'text', text: [
    '召唤结果：', '- generalist:', 'review line one', 'review line two',
    '- Missing: 失败（专家不存在：Missing；可先调用 list_experts 浏览花名册（惯用名见 roster-aliases.json））',
    '- code-reviewer:', 'Types checked.',
  ].join('\n') }])
})

it('preserves the answer returned by a direct summon', async () => {
  const { ctx, parent, release } = await setup('native')
  release.resolve()
  const result = await ctx.tools.execute({
    name: 'summon_expert', agent: parent, arguments: task, callId: ToolCallId('native'), signal: new AbortController().signal,
  })
  expect(result.value).toEqual({ expert: 'generalist', answer: 'review finished' })
  expect(ctx.jobs.list(parent.id)).toEqual([])
})
