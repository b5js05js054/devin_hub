import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { BrowserToolError } from '../src/errors.ts'
import { BROWSER_NAMESPACE, childEnvironment, closeBrowser, globalArguments, outputArguments, runBatch } from '../src/run.ts'
import type { CliInvocation } from '../src/run.ts'

interface FakeRun {
  stdout?: string
  stderr?: string
  lossy?: boolean
  outcome?: SubprocessOutcome | Promise<SubprocessOutcome>
  collected?: boolean
}

function fakeSubprocess(run: FakeRun | (() => never)): { ctx: Context; spawns: SubprocessSpawnSpec[] } {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const spawns: SubprocessSpawnSpec[] = []
  ctx.provide('subprocess', {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      spawns.push(spec)
      if (typeof run === 'function') return run()
      const reader = (text: string, lossy: boolean) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy }) })
      return {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        control: undefined,
        collected: run.collected === false ? {} : { stdout: reader(run.stdout ?? '', run.lossy ?? false), stderr: reader(run.stderr ?? '', false) },
        done: Promise.resolve(run.outcome ?? { exitCode: 0, signal: null }),
        terminate: () => {},
        waitForExit: () => Promise.resolve(true),
      }
    },
  } as never)
  return { ctx, spawns }
}

function invocation(overrides: Partial<CliInvocation> = {}): CliInvocation {
  return {
    program: ['/opt/agent-browser'],
    launch: { session: 'session-a', headed: false, browserArgs: [] },
    cwd: '/tmp/browser/session-a',
    env: { AGENT_BROWSER_NO_VERSION_CHECK: '1' },
    limits: { maxOutputBytes: 1_000, stderrMaxBytes: 100, graceMs: 50 },
    signal: new AbortController().signal,
    ...overrides,
  }
}

async function failure(operation: Promise<unknown>): Promise<BrowserToolError> {
  const error = await operation.then(() => undefined, (reason: unknown) => reason)
  if (!(error instanceof BrowserToolError)) throw new Error(`expected a BrowserToolError, received ${String(error)}`)
  return error
}

describe('globalArguments', () => {
  it('addresses the session in the tool namespace with its launch settings', () => {
    expect(globalArguments({ session: 'session-a', headed: false, browserArgs: [] }))
      .toEqual(['--namespace', BROWSER_NAMESPACE, '--session', 'session-a', '--headed', 'false'])
    expect(globalArguments({
      session: 'session-b',
      headed: true,
      executablePath: '/usr/bin/microsoft-edge',
      browserArgs: ['--do-not-de-elevate', '--lang=zh-CN'],
      restore: 'session-b',
    })).toEqual([
      '--namespace', BROWSER_NAMESPACE, '--session', 'session-b', '--headed', 'true',
      '--executable-path', '/usr/bin/microsoft-edge',
      '--args', '--do-not-de-elevate,--lang=zh-CN',
      '--restore', 'session-b',
    ])
  })
})

describe('outputArguments', () => {
  it('sends saved files to the output directory and labels screenshots only on request', () => {
    expect(outputArguments('/tmp/browser/session-a', false)).toEqual(['--screenshot-dir', '/tmp/browser/session-a', '--download-path', '/tmp/browser/session-a'])
    expect(outputArguments('/tmp/browser/session-a', true))
      .toEqual(['--screenshot-dir', '/tmp/browser/session-a', '--download-path', '/tmp/browser/session-a', '--annotate'])
  })
})

describe('childEnvironment', () => {
  it('removes ambient CLI settings in any letter case and disables the release-feed check', () => {
    expect(childEnvironment({
      AGENT_BROWSER_SESSION: 'ambient',
      agent_browser_cdp: '9222',
      AGENT_BROWSER_NO_VERSION_CHECK: '0',
      PATH: '/usr/bin',
    })).toEqual({
      AGENT_BROWSER_SESSION: undefined,
      agent_browser_cdp: undefined,
      AGENT_BROWSER_NO_VERSION_CHECK: '1',
    })
    expect(childEnvironment({})).toEqual({ AGENT_BROWSER_NO_VERSION_CHECK: '1' })
  })
})

describe('runBatch', () => {
  const rows = [{ command: ['get', 'url'], success: true, error: null, result: { lifecycle: {}, url: 'https://example.com/' } }]

  it('sends the commands as one bailing batch and decodes the report', async () => {
    const { ctx, spawns } = fakeSubprocess({ stdout: JSON.stringify(rows), outcome: { exitCode: 1, signal: null } })
    const run = invocation()
    expect(await runBatch(ctx, run, [['get', 'url'], ['back']], false)).toEqual({
      results: [{ command: ['get', 'url'], success: true, result: { url: 'https://example.com/' } }],
      skipped: 1,
    })
    expect(spawns).toEqual([{
      argv: [
        '/opt/agent-browser', '--namespace', BROWSER_NAMESPACE, '--session', 'session-a', '--headed', 'false',
        '--screenshot-dir', '/tmp/browser/session-a', '--download-path', '/tmp/browser/session-a',
        'batch', '--json', '--bail',
      ],
      cwd: '/tmp/browser/session-a',
      env: { AGENT_BROWSER_NO_VERSION_CHECK: '1' },
      stdio: { stdin: { data: '[["get","url"],["back"]]' }, stdout: { maxBytes: 1_000 }, stderr: { maxBytes: 100 } },
      graceMs: 50,
      signal: run.signal,
    }])
  })

  it('does not start a call whose signal already aborted', async () => {
    const { ctx, spawns } = fakeSubprocess({})
    const error = await failure(runBatch(ctx, invocation({ signal: AbortSignal.abort() }), [['get', 'url']], false))
    expect([error.code, error.message]).toEqual(['BROWSER_ABORTED', 'the browser call was cancelled before it started'])
    expect(spawns).toEqual([])
  })

  it('reports a spawn failure and a provider failure with their causes', async () => {
    const spawnFailure = new Error('spawn EINVAL')
    const thrown = await failure(runBatch(fakeSubprocess(() => { throw spawnFailure }).ctx, invocation(), [['get', 'url']], false))
    expect([thrown.code, thrown.message, thrown.cause]).toEqual(['BROWSER_FAILED', 'browser automation could not start its program', spawnFailure])

    const providerFailure = new Error('runner exited')
    const rejected = await failure(runBatch(fakeSubprocess({ outcome: Promise.reject(providerFailure) }).ctx, invocation(), [['get', 'url']], false))
    expect([rejected.code, rejected.message, rejected.cause]).toEqual(['BROWSER_FAILED', 'browser automation failed before reporting an outcome', providerFailure])
  })

  it('reports cancellation that arrives while the commands run', async () => {
    const controller = new AbortController()
    const outcome = Promise.withResolvers<SubprocessOutcome>()
    const { ctx } = fakeSubprocess({ stdout: JSON.stringify(rows), outcome: outcome.promise })
    const pending = failure(runBatch(ctx, invocation({ signal: controller.signal }), [['get', 'url']], false))
    controller.abort()
    outcome.resolve({ exitCode: null, signal: 'SIGTERM' })
    const error = await pending
    expect([error.code, error.message]).toEqual(['BROWSER_ABORTED', 'the browser call was cancelled or timed out; commands already sent may have taken effect'])
  })

  it('reports missing collected streams, truncated output, and an empty report', async () => {
    const missing = await failure(runBatch(fakeSubprocess({ collected: false }).ctx, invocation(), [['get', 'url']], false))
    expect([missing.code, missing.message]).toEqual(['BROWSER_FAILED', 'browser automation produced no collected output'])

    const overflow = await failure(runBatch(fakeSubprocess({ stdout: '[', lossy: true }).ctx, invocation(), [['snapshot']], true))
    expect([overflow.code, overflow.message]).toEqual([
      'BROWSER_OUTPUT_OVERFLOW',
      'the browser returned more than 1000 bytes; the commands ran, so read the page again with a narrower request such as snapshot -i or get text <selector>',
    ])

    const diagnosed = await failure(runBatch(fakeSubprocess({ stdout: ' \n', stderr: '✗ Daemon failed to start\n', outcome: { exitCode: 1, signal: null } }).ctx, invocation(), [['open']], false))
    expect([diagnosed.code, diagnosed.message]).toEqual(['BROWSER_FAILED', 'the browser could not run the commands: ✗ Daemon failed to start'])

    const silent = await failure(runBatch(fakeSubprocess({ outcome: { exitCode: 3, signal: null } }).ctx, invocation(), [['open']], false))
    expect([silent.code, silent.message]).toEqual(['BROWSER_FAILED', 'the browser could not run the commands (exit code 3)'])
  })
})

describe('closeBrowser', () => {
  it('closes the session without sending launch settings', async () => {
    const { ctx, spawns } = fakeSubprocess({ stdout: '✓ Browser closed' })
    await closeBrowser(ctx, invocation({ launch: { session: 'session-a', headed: true, browserArgs: ['--x'], restore: 'shared' } }))
    expect(spawns.map(spec => [spec.argv, spec.stdio.stdin])).toEqual([
      [['/opt/agent-browser', '--namespace', BROWSER_NAMESPACE, '--session', 'session-a', 'close'], 'ignore'],
    ])
  })
})
