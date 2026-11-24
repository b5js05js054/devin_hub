/**
 * One invocation of the agent-browser CLI through the subprocess service.
 * The CLI hands each command to a per-session background daemon that owns
 * the browser, so an invocation is short and the browser outlives it.
 * @module @deepseek-ai/dsh-tool-browser/run
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { BrowserToolError } from './errors.ts'
import { parseBatchReport } from './render.ts'
import type { BatchReport } from './render.ts'

/** Isolates this tool's daemons and saved state from other agent-browser users on the host. */
export const BROWSER_NAMESPACE = 'dsh'

/** The launch settings sent with every invocation; the daemon relaunches the browser only when one changes. */
export interface BrowserLaunch {
  /** The daemon and browser this invocation addresses. */
  session: string
  /** Whether the browser window is visible. */
  headed: boolean
  /** Explicit browser executable; omitted uses the CLI's discovery. */
  executablePath?: string
  /** Extra browser launch arguments. */
  browserArgs: readonly string[]
  /** Key under which cookies and storage persist across browser restarts; omitted disables persistence. */
  restore?: string
}

/**
 * Build the CLI's global options for one launch.
 * @param launch - the session and its launch settings.
 * @returns the arguments that precede the CLI command.
 */
export function globalArguments(launch: BrowserLaunch): string[] {
  return [
    '--namespace', BROWSER_NAMESPACE,
    '--session', launch.session,
    '--headed', String(launch.headed),
    ...launch.executablePath === undefined ? [] : ['--executable-path', launch.executablePath],
    ...launch.browserArgs.length === 0 ? [] : ['--args', launch.browserArgs.join(',')],
    ...launch.restore === undefined ? [] : ['--restore', launch.restore],
  ]
}

/**
 * Build the environment entries layered over the subprocess service's
 * scrubbed parent environment. Ambient `AGENT_BROWSER_*` values would
 * otherwise redirect the CLI to another session, browser, or endpoint.
 * @param ambient - the host process environment.
 * @returns tombstones for ambient CLI settings plus this tool's own.
 */
export function childEnvironment(ambient: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(ambient)) {
    if (key.toUpperCase().startsWith('AGENT_BROWSER_')) env[key] = undefined
  }
  // The outdated-browser check fetches a release feed on each launch.
  env['AGENT_BROWSER_NO_VERSION_CHECK'] = '1'
  return env
}

/** Byte and time bounds of one CLI invocation. */
export interface RunLimits {
  /** Cap on the standard output the tool will parse. */
  maxOutputBytes: number
  /** Cap on the retained standard-error diagnostic tail. */
  stderrMaxBytes: number
  /** Terminate-escalation grace handed to the subprocess service. */
  graceMs: number
}

/** A CLI invocation: the program, its launch settings, where it runs, and its bounds. */
export interface CliInvocation {
  /** The CLI program and any leading arguments. */
  program: readonly string[]
  launch: BrowserLaunch
  /** The session's output directory: relative file arguments resolve in it, and the browser saves its own files there. */
  cwd: string
  env: NodeJS.ProcessEnv
  limits: RunLimits
  signal: AbortSignal
}

/** Collected output and exit facts of one finished invocation. */
interface CliRun {
  outcome: SubprocessOutcome
  stdout: string
  stdoutLossy: boolean
  stderr: string
}

async function runCli(ctx: Context, invocation: CliInvocation, args: readonly string[], stdin: string | undefined): Promise<CliRun> {
  const { limits, signal } = invocation
  if (signal.aborted) throw new BrowserToolError('the browser call was cancelled before it started', 'BROWSER_ABORTED')
  let handle: SubprocessHandle
  try {
    handle = ctx.subprocess.spawn({
      argv: [...invocation.program, ...args],
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: {
        stdin: stdin === undefined ? 'ignore' : { data: stdin },
        stdout: { maxBytes: limits.maxOutputBytes },
        stderr: { maxBytes: limits.stderrMaxBytes },
      },
      graceMs: limits.graceMs,
      signal,
    })
  } catch (error: unknown) {
    throw new BrowserToolError('browser automation could not start its program', 'BROWSER_FAILED', { cause: error })
  }
  let outcome: SubprocessOutcome
  try {
    outcome = await handle.done
  } catch (error: unknown) {
    throw new BrowserToolError('browser automation failed before reporting an outcome', 'BROWSER_FAILED', { cause: error })
  }
  // The signal can abort while the invocation is awaited; control-flow narrowing cannot see that.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  if (signal.aborted) {
    throw new BrowserToolError('the browser call was cancelled or timed out; commands already sent may have taken effect', 'BROWSER_ABORTED')
  }
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined) {
    throw new BrowserToolError('browser automation produced no collected output', 'BROWSER_FAILED')
  }
  return { outcome, stdout: stdout.text, stdoutLossy: stdout.lossy, stderr: stderr.text }
}

/**
 * Build the CLI's global options that govern saved files for one invocation.
 * Without them the browser discards click-started downloads and saves
 * unnamed screenshots in the user's home directory.
 * @param directory - the session's output directory.
 * @param annotate - whether screenshots carry numbered element labels.
 * @returns the arguments that follow the launch settings.
 */
export function outputArguments(directory: string, annotate: boolean): string[] {
  return ['--screenshot-dir', directory, '--download-path', directory, ...annotate ? ['--annotate'] : []]
}

/**
 * Run commands in order in the session's browser, stopping at the first failure.
 * @param ctx - plugin context supplying the subprocess service.
 * @param invocation - program, launch settings, working directory, and bounds.
 * @param commands - admitted commands, each an argument vector.
 * @param annotate - whether this call's screenshots carry numbered element labels.
 * @returns the per-command outcomes; a failed command is an outcome, not a rejection.
 * @throws BrowserToolError when the CLI cannot run, is cancelled, or returns no usable report.
 */
export async function runBatch(
  ctx: Context,
  invocation: CliInvocation,
  commands: readonly (readonly string[])[],
  annotate: boolean,
): Promise<BatchReport> {
  const run = await runCli(
    ctx,
    invocation,
    [...globalArguments(invocation.launch), ...outputArguments(invocation.cwd, annotate), 'batch', '--json', '--bail'],
    JSON.stringify(commands),
  )
  if (run.stdoutLossy) {
    throw new BrowserToolError(
      `the browser returned more than ${invocation.limits.maxOutputBytes} bytes; the commands ran, so read the page again with a narrower request such as snapshot -i or get text <selector>`,
      'BROWSER_OUTPUT_OVERFLOW',
    )
  }
  if (run.stdout.trim().length === 0) {
    const detail = run.stderr.trim()
    throw new BrowserToolError(
      `the browser could not run the commands${detail.length === 0 ? ` (exit code ${String(run.outcome.exitCode)})` : `: ${detail}`}`,
      'BROWSER_FAILED',
    )
  }
  return parseBatchReport(run.stdout, commands.length)
}

/**
 * Close a session's browser and end its daemon. Launch settings are not
 * sent, so closing never starts or restarts a browser.
 * @param ctx - plugin context supplying the subprocess service.
 * @param invocation - program, session, working directory, and bounds.
 * @returns after the CLI reports; a session with no daemon closes as a no-op.
 * @throws BrowserToolError when the CLI cannot run or is cancelled.
 */
export async function closeBrowser(ctx: Context, invocation: CliInvocation): Promise<void> {
  await runCli(ctx, invocation, ['--namespace', BROWSER_NAMESPACE, '--session', invocation.launch.session, 'close'], undefined)
}
