/** Real file-tool intents from locally owned Agents, across turn and Session lifetimes. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { mountRuntime } from '../../../ptc-runtime/ptc-runtime-node/tests/setup.ts'
import { mountLocalActivations } from '../../../subagent/subagent/tests/local-activation.ts'
import * as WorkspaceChanges from '../src/index.ts'
import { changes, endTurn, scratchDir, settle, startTurn, toolCall } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

const signal = new AbortController().signal
let callNumber = 0

async function boot(persistence = false) {
  const cwd = await scratchDir('dsh-delegated-edits-', cleanups)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  if (persistence) await mountLocalActivations(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ToolFs)
  await ctx.plugin(WorkspaceChanges)
  // A shared working-tree snapshot cannot distinguish two simultaneous writers. Exercise the capture-only path.
  const resolve = ctx.subprocess.resolveExecutable.bind(ctx.subprocess)
  vi.spyOn(ctx.subprocess, 'resolveExecutable').mockImplementation((name, ...options) =>
    name === 'git' ? Promise.reject(new Error('git unavailable')) : resolve(name, ...options))
  const root = (id: string) => ctx.agents.create({ sessionId: SessionId(id), meta: { cwd } })
  return { ctx, cwd, root, harness }
}

async function execute(ctx: Context, agent: Agent, name: string, args: unknown): Promise<void> {
  const result = await ctx.tools.execute({ agent, name, arguments: args, callId: ToolCallId(`call-${++callNumber}`), signal })
  if (result.isError) throw new Error(`${name}: ${result.error.message}`)
}

/** Run the actual Agent factory inside a registered parent tool, as the local subagent manager does. */
async function launch(ctx: Context, parent: Agent, create: () => Promise<AgentHandle>): Promise<AgentHandle> {
  const name = `delegate_${++callNumber}`
  let child: AgentHandle | undefined
  const remove = ctx.tools.register(defineContentToolFixture({
    name, description: 'Delegate to a local Agent', parameters: {},
    async execute() { child = await create(); return [{ type: 'text', text: child.agent.id }] },
  }))
  try {
    await execute(ctx, parent, name, {})
    if (child === undefined) throw new Error('delegation did not publish a child')
    return child
  } finally { remove() }
}

function childOptions(parent: Agent, id: string): CreateAgentOptions {
  return {
    sessionId: SessionId(id), parentAgent: parent,
    meta: { ...parent.session.header.cwd === undefined ? {} : { cwd: parent.session.header.cwd },
      parentSession: parent.id, origin: 'subagent', delegationDepth: (parent.session.header.delegationDepth ?? 0) + 1 },
  }
}

function spawn(ctx: Context, parent: Agent, id: string): Promise<AgentHandle> {
  return launch(ctx, parent, () => ctx.agents.create(childOptions(parent, id)))
}

function write(ctx: Context, agent: Agent, path: string) {
  return execute(ctx, agent, 'write', { file_path: path, content: `${path}\n` })
}

async function finish(ctx: Context, agent: Agent, turn: number) {
  endTurn(agent.session, turn)
  await settle(ctx, agent.session)
  return changes(ctx, agent.session).map(summary => summary.files.map(file => file.display))
}

it('assigns child and grandchild intents in a shared directory to the root that delegated each edit', async () => {
  const { ctx, cwd, root } = await boot()
  const { agent: a } = await root('root-a')
  const { agent: b } = await root('root-b')
  startTurn(a.session, 1)
  startTurn(b.session, 1)
  const [ca, cb] = await Promise.all([spawn(ctx, a, 'child-a'), spawn(ctx, b, 'child-b')])
  startTurn(ca.agent.session, 1)
  startTurn(cb.agent.session, 1)
  const grandchild = await spawn(ctx, ca.agent, 'grandchild')
  startTurn(grandchild.agent.session, 1)
  await mkdir(join(cwd, 'nested'))
  await ctx.workingDirectory.set(grandchild.agent, join(cwd, 'nested'))
  await writeFile(join(cwd, 'nested', 'grand.txt'), 'before\n')
  await write(ctx, a, 'direct.txt')
  await write(ctx, ca.agent, 'child.txt')
  await execute(ctx, grandchild.agent, 'edit', { file_path: 'grand.txt', old_string: 'before', new_string: 'after' })
  await write(ctx, cb.agent, 'other.txt')
  toolCall(a.session, 1, 'wait_agent', {})
  toolCall(b.session, 1, 'wait_agent', {})
  for (const handle of [grandchild, ca, cb]) {
    toolCall(handle.agent.session, 1, 'write', {})
    expect(await finish(ctx, handle.agent, 1)).toEqual([])
    await handle.dispose()
  }
  expect(await finish(ctx, a, 1)).toEqual([['child.txt', 'direct.txt', 'nested/grand.txt']])
  expect(await finish(ctx, b, 1)).toEqual([['other.txt']])
  const seq = a.session.snapshotEvents().find(event => event.type === 'workspace/changes')!.seq
  expect(await ctx.workspaceChanges.diff(a.id, seq, 2, signal)).toMatchObject({ kind: 'text', hunks: [{ lines: ['-before', '+after'] }] })
})

it('records a delegated PTC write even when the parent has no settled tool result', async () => {
  const { ctx, root } = await boot()
  const { runtime } = await mountRuntime(ctx, { executionMode: 'per-call' })
  const { agent: parent } = await root('parent')
  startTurn(parent.session, 1)
  const { agent: child } = await spawn(ctx, parent, 'ptc-child')
  child.ctx.tools.presentAs('ptc')
  startTurn(child.session, 1)
  await execute(ctx, child, 'run_code', {
    code: 'await tools.write({ file_path: "ptc.txt", content: "from child\\n" })', description: 'write the delegated file',
  })
  expect(child.session.snapshotEvents().find(event => event.type === 'tool/ptc-dispatch'))
    .toMatchObject({ data: { name: 'write', isError: false } })
  expect(parent.session.snapshotEvents().some(event => event.type === 'tool/result')).toBe(false)
  expect(await finish(ctx, parent, 1)).toEqual([['ptc.txt']])

  // SDK calls can be submitted after the outer run_code's original root turn ends.
  parent.ctx.tools.presentAs('ptc')
  startTurn(parent.session, 2)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const run = runtime.run.bind(runtime)
  vi.spyOn(runtime, 'run').mockImplementationOnce(async (spec) => {
    entered.resolve(undefined)
    await release.promise
    return run(spec)
  })
  const late = execute(ctx, parent, 'run_code', {
    code: 'await tools.write({ file_path: "late-ptc.txt", content: "late" })', description: 'write from the older program',
  })
  try {
    await Promise.race([entered.promise, late])
    endTurn(parent.session, 2)
    startTurn(parent.session, 3)
  } finally { release.resolve(undefined) }
  await late
  toolCall(parent.session, 3, 'run_code', {})
  expect(await finish(ctx, parent, 3)).toEqual([['ptc.txt']])
})

it('drops delayed intents, delayed launches and background descendants after their parent turn closes', async () => {
  const { ctx, cwd, root } = await boot()
  const { agent: parent } = await root('parent')
  startTurn(parent.session, 1)
  const { agent: child } = await spawn(ctx, parent, 'old-child')
  const atGuard = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  ctx.on('fs/write-intent', async (target, _actor, next) => {
    if (ctx.fs.processPath(target) === join(cwd, 'delayed.txt')) {
      atGuard.resolve(undefined)
      await release.promise
    }
    return next()
  })
  const writing = write(ctx, child, 'delayed.txt')
  const atLaunch = Promise.withResolvers<undefined>()
  const launching = launch(ctx, parent, async () => {
    atLaunch.resolve(undefined)
    await release.promise
    return ctx.agents.create(childOptions(parent, 'delayed-child'))
  })
  try {
    await Promise.all([Promise.race([atGuard.promise, writing]), Promise.race([atLaunch.promise, launching])])
    endTurn(parent.session, 1)
    await write(ctx, child, 'between.txt')
    startTurn(parent.session, 2)
  } finally { release.resolve(undefined) }
  const [delayed] = await Promise.all([launching, writing])
  await write(ctx, delayed.agent, 'late-launch.txt')
  const nested = await spawn(ctx, child, 'late-grandchild')
  await write(ctx, nested.agent, 'background.txt')
  const current = await spawn(ctx, parent, 'current-child')
  await write(ctx, current.agent, 'current.txt')
  const disposed = await spawn(ctx, parent, 'disposed-child')
  await disposed.dispose()
  const replacement = await ctx.agents.create(childOptions(parent, 'disposed-child'))
  await write(ctx, replacement.agent, 'reused-id.txt')
  toolCall(parent.session, 2, 'wait_agent', {})
  expect(await readFile(join(cwd, 'delayed.txt'), 'utf8')).toBe('delayed.txt\n')
  expect(await finish(ctx, parent, 2)).toEqual([['current.txt']])
})

it('attributes a resident child’s next assignment when it claims a message from its parent tool', async () => {
  const { ctx, root, harness } = await boot()
  const { agent: parent } = await root('parent')
  const { agent: unrelated } = await root('other-root')
  startTurn(parent.session, 1)
  const { agent: child } = await spawn(ctx, parent, 'resident')
  startTurn(child.session, 1)
  endTurn(parent.session, 1)
  startTurn(parent.session, 2)
  startTurn(unrelated.session, 1)
  ctx.tools.register(defineContentToolFixture({
    name: 'give_work', description: 'Send a new assignment', parameters: {},
    async execute(_args, exec) {
      child.inbox.append('next-step', createUserMessage({
        content: [{ type: 'text', text: 'Continue the task' }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: exec.agent!.id },
      }))
      return [{ type: 'text', text: 'queued' }]
    },
  }))
  await execute(ctx, unrelated, 'give_work', {})
  expect(harness.claim(child, 'next-step', 1)).toHaveLength(1)
  await write(ctx, child, 'other-tree.txt')
  await execute(ctx, parent, 'give_work', {})
  await write(ctx, child, 'before-claim.txt')
  expect(harness.claim(child, 'next-step', 1)).toHaveLength(1)
  await write(ctx, child, 'new-assignment.txt')
  expect(await finish(ctx, unrelated, 1)).toEqual([])
  expect(await finish(ctx, parent, 2)).toEqual([['new-assignment.txt']])
})

it('binds a cold child resumed by its parent tool and excludes a detached resume of the same durable id', async () => {
  const { ctx, root } = await boot(true)
  const { agent: parent } = await root('parent')
  const first = await ctx.agents.create(childOptions(parent, 'resumable'))
  startTurn(first.agent.session, 1)
  endTurn(first.agent.session, 1)
  await first.dispose()
  startTurn(parent.session, 1)
  const detached = await ctx.agents.resume({ resumeSessionId: first.agent.id })
  await write(ctx, detached.agent, 'detached.txt')
  await detached.dispose()
  const resumed = await launch(ctx, parent, () => ctx.agents.resume({ resumeSessionId: first.agent.id, parentAgent: parent }))
  await write(ctx, resumed.agent, 'resumed.txt')
  toolCall(parent.session, 1, 'send_message', {})
  expect(await finish(ctx, parent, 1)).toEqual([['resumed.txt']])
})
