/**
 * Summarizes the files each top-level turn changed from git working-tree
 * snapshots and whole-file captures of file-tool edits by the root and its
 * delegated local agents. When git or a usable snapshot comparison is
 * unavailable, captured file-tool edits provide the summary and comparisons.
 * A `workspace/changes` Session event announces the turn number. The
 * `workspaceChanges` service serves its files and diffs until Session disposal.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { homedir, tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { GitRunner } from './git.ts'
import { TurnRecorder } from './recorder.ts'
import type { WorkspaceChanges } from './types.ts'

export type {
  WorkspaceChangedFile, WorkspaceChanges, WorkspaceChangesSummary, WorkspaceDiffHunk, WorkspaceFileDiff,
} from './types.ts'

/** Stable Loader identity. */
export const name = 'workspace-changes'

/** Services used to run git, resolve mutation targets, and observe turns. */
export const inject = ['subprocess', 'fs']

/** Snapshot, capture, and comparison bounds. Invalid values fail plugin load. */
export interface Config {
  /** Milliseconds allowed for one git command. A timed-out snapshot falls back to file-tool captures. */
  timeoutMs: number
  /** Bytes retained per git command. A larger snapshot listing falls back to file-tool captures. */
  outputMaxBytes: number
  /** Maximum files carried by one summary; `total` still reports the complete count. */
  maxFiles: number
  /**
   * Bytes a file may hold to be captured around a file-tool edit or read from a snapshot for its comparison.
   * A larger file gets no comparison; one captured around a file-tool edit is also listed without counts.
   */
  maxFileBytes: number
  /** Milliseconds a line comparison may run before it degrades to whole-file replacement. */
  diffTimeoutMs: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(30_000),
  outputMaxBytes: z.number().default(8 * 1024 * 1024),
  maxFiles: z.number().default(500),
  maxFileBytes: z.number().default(2 * 1024 * 1024),
  diffTimeoutMs: z.number().default(100),
})

function delegated(session: Session): boolean {
  const { origin, delegationDepth } = session.header
  return origin === 'subagent' || (delegationDepth ?? 0) > 0
}

/** One root turn that launched or assigned work to a local agent. */
interface RootTurn {
  readonly session: Session
  readonly turn: number
  readonly recorder: TurnRecorder
}

/** The exact local agent and root turn on whose behalf a tool began. */
interface ToolOwner {
  readonly agent: Agent
  readonly root: RootTurn
}

/**
 * Resolve the git executable once. On macOS the Xcode stub at `/usr/bin/git`
 * opens an installer dialog instead of running, so it counts as absent until
 * developer tools are selected.
 * @param ctx - subprocess capability.
 * @param signal - plugin lifetime.
 * @returns the executable path, or null when git is unavailable.
 */
async function resolveGit(ctx: Context, signal: AbortSignal): Promise<string | null> {
  let executable: string
  try {
    executable = await ctx.subprocess.resolveExecutable('git', undefined, signal)
  } catch {
    return null
  }
  if (process.platform !== 'darwin' || executable !== '/usr/bin/git') return executable
  const probe = ctx.subprocess.spawn({
    argv: ['/usr/bin/xcode-select', '-p'], cwd: homedir(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 1_000, signal,
  })
  const outcome = await probe.done.catch(() => ({ exitCode: null }))
  return outcome.exitCode === 0 ? executable : null
}

/**
 * Observe top-level turns of every Session with a working directory, capture
 * file-tool edits, announce change summaries, and serve them with their
 * comparisons as `workspaceChanges`.
 * @param ctx - host context with `subprocess` and `fs`.
 * @param config - validated bounds.
 */
export function apply(ctx: Context, config: Config): void {
  for (const [field, value] of [
    ['timeoutMs', config.timeoutMs], ['outputMaxBytes', config.outputMaxBytes], ['maxFiles', config.maxFiles],
    ['maxFileBytes', config.maxFileBytes], ['diffTimeoutMs', config.diffTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`workspace-changes requires a positive integer ${field}`)
  }
  const lifetime = new AbortController()
  const recorders = new Map<Session, TurnRecorder>()
  const turns = new WeakMap<Session, RootTurn>()
  const assignments = new WeakMap<Session, Map<UserMessage['id'], RootTurn>>()
  const mutations = new WeakMap<object, ToolOwner>()
  const transports = new WeakMap<ToolExecutionToken, ToolOwner>()
  const executing = new AsyncLocalStorage<ToolOwner | undefined>()
  const byId = new Map<SessionId, TurnRecorder>()
  const active = ({ agent, root }: ToolOwner): boolean =>
    turns.get(agent.session) === root && turns.get(root.session) === root
  const parentTurn = (child: Agent): RootTurn | undefined => {
    const owner = executing.getStore()
    // A durable parentSession also exists on forks and detached resumes. Check the parent that owns this live child.
    if (owner === undefined || !active(owner) || !delegated(child.session)) return undefined
    if (child.session.header.parentSession !== owner.agent.id) return undefined
    return ctx.get('agents')?.isOwnedBy(child.id, owner.agent) ? owner.root : undefined
  }
  const forget = (session: Session): Promise<void> => {
    const recorder = recorders.get(session)
    turns.delete(session)
    assignments.delete(session)
    recorders.delete(session)
    if (byId.get(session.id) === recorder) byId.delete(session.id)
    return recorder?.dispose() ?? Promise.resolve()
  }
  ctx.effect(() => async () => {
    lifetime.abort()
    executing.disable()
    await Promise.all([...recorders.keys()].map(forget))
  })
  const service: WorkspaceChanges = {
    summary: (sessionId, seq) => byId.get(sessionId)?.summary(seq),
    diff: (sessionId, seq, index, signal) => byId.get(sessionId)?.diff(seq, index, signal) ?? Promise.resolve(undefined),
  }
  ctx.provide('workspaceChanges', service)
  let runner: Promise<GitRunner | null> | undefined
  const gitRunner = (): Promise<GitRunner | null> => {
    runner ??= resolveGit(ctx, lifetime.signal).then((executable) => {
      if (executable === null) {
        ctx.logger.info('workspace-changes: git is unavailable; only file-tool edits are summarized')
        return null
      }
      return new GitRunner(ctx.subprocess, executable, { timeoutMs: config.timeoutMs, outputMaxBytes: config.outputMaxBytes })
    })
    return runner
  }
  const recorderFor = (session: Session, cwd: string): TurnRecorder => {
    let recorder = recorders.get(session)
    if (recorder === undefined) {
      recorder = new TurnRecorder(session, cwd, {
        git: gitRunner(), tempRoot: tmpdir(), maxFiles: config.maxFiles,
        maxFileBytes: config.maxFileBytes, diffTimeoutMs: config.diffTimeoutMs,
        warn: (message) => { ctx.logger.warn(message) },
      })
      recorders.set(session, recorder)
      byId.set(session.id, recorder)
    }
    return recorder
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      const { cwd } = session.header
      if (cwd !== undefined && !delegated(session)) {
        const recorder = recorderFor(session, cwd)
        recorder.start(event.data.turn)
        turns.set(session, { session, turn: event.data.turn, recorder })
      }
      return
    }
    if (event.type === 'tool/result') recorders.get(session)?.observe(event)
    else if (event.type === 'turn/end') {
      const root = turns.get(session)
      if (root?.session === session && root.turn === event.data.turn) {
        turns.delete(session)
        root.recorder.end(root.turn)
      }
    }
  })
  ctx.on('agent/created', ({ agent }) => {
    const root = parentTurn(agent)
    if (root !== undefined) turns.set(agent.session, root)
  }, { prepend: true })
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    // A resident child keeps working on its previous assignment until it claims the parent's message.
    const source: { kind: string; senderSessionId?: SessionId } = message.source
    if (source.kind !== 'agent-message' || source.senderSessionId !== agent.session.header.parentSession) return
    const root = parentTurn(agent)
    if (root === undefined) return
    let pending = assignments.get(agent.session)
    if (pending === undefined) {
      pending = new Map()
      assignments.set(agent.session, pending)
    }
    pending.set(message.id, root)
  })
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    const pending = assignments.get(agent.session)
    if (pending === undefined) return
    const root = pending.get(message.id)
    if (root === undefined) return
    pending.delete(message.id)
    turns.set(agent.session, root)
  })
  ctx.on('agent/inbox/discarded', ({ agent, message }) => { assignments.get(agent.session)?.delete(message.id) })
  ctx.on('session/disposed', (session) => { void forget(session) })
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    await recorders.get(agent.session)?.stopping(turn)
  })
  const capture = async (target: FsTarget, actor: object | undefined): Promise<void> => {
    const owner = actor === undefined ? undefined : mutations.get(actor)
    if (owner === undefined || !active(owner)) return
    owner.root.recorder.capture(ctx.fs.processPath(target))
    await owner.root.recorder.settled()
  }
  ctx.on('fs/write-intent', async (target, actor, next) => {
    const intent = await next()
    await capture(target, actor)
    return intent
  }, { prepend: true })
  ctx.on('fs/edit-intent', async (target, actor, next) => {
    const intent = await next()
    await capture(target, actor)
    return intent
  }, { prepend: true })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const { agent } = exec
    if (agent !== undefined) {
      // A PTC sub-call inherits the outer program's turn even if the Session has advanced before dispatch.
      const root = exec.parent === undefined ? turns.get(agent.session) : transports.get(exec.parent)?.root
      if (root !== undefined) {
        const owner = { agent, root }
        if (active(owner)) {
          mutations.set(exec, owner)
          await root.recorder.settled()
        }
      } else {
        // A top-level tool arriving between turns still waits for the queued turn-end snapshot.
        await recorders.get(agent.session)?.settled()
      }
    }
    return next()
  }, { prepend: true })
  ctx.on('tools/execute', (exec, next) => {
    const owner = mutations.get(exec)
    if (owner !== undefined) transports.set(exec.token, owner)
    return executing.run(owner, next)
  }, { prepend: true })
}
