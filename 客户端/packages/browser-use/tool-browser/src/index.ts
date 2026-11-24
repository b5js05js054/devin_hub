/**
 * Model-facing `browser` tool over the packaged agent-browser CLI
 * (`agent-browser`, an npm dependency): one tool that runs ordered browser
 * commands in a browser owned by the calling Session, plus the system-prompt
 * section that teaches those commands.
 *
 * The plugin owns the schema, command admission, launch settings, result
 * rendering, and each Session's browser lifetime. The CLI owns the browser
 * and its page operations; the subprocess service owns process execution.
 *
 * @module @deepseek-ai/dsh-tool-browser
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { admitCommands, liftAnnotation } from './commands.ts'
import { resolveBrowserExecutable, resolveCliProgram } from './executable.ts'
import type { BrowserHost } from './executable.ts'
import { claimNewFiles, listSavedFiles } from './files.ts'
import { BROWSER_TOOL_DESCRIPTION, BROWSER_TOOL_NAME, browserGuidance } from './prompt.ts'
import { anchorSavedPaths, displayCommand, renderOutput, summarizeCommands } from './render.ts'
import type { BrowserOutput } from './render.ts'
import { childEnvironment, closeBrowser, runBatch } from './run.ts'
import type { CliInvocation } from './run.ts'

export { BrowserToolError } from './errors.ts'
export type { BrowserToolErrorCode } from './errors.ts'
export { BROWSER_TOOL_NAME } from './prompt.ts'
export type { BrowserCommandResult, BrowserOutput } from './render.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-browser'

/** Services required by the browser tool (`sandboxPolicy` is optional, read via `ctx.get()`). */
export const inject = ['tools', 'systemPrompt', 'subprocess']

/** How cookies and site storage outlive a browser restart. */
export type BrowserRestore = 'off' | 'session' | 'shared'

/** Plugin config: the browser to drive, its default visibility, state persistence, and per-call bounds. */
export interface Config {
  /** Absolute path of the browser executable. Omitted uses installed Chrome, then installed Microsoft Edge. */
  executablePath?: string
  /** Whether a Session's browser window is visible until a call sets `headed`. */
  headed?: boolean
  /** Extra browser launch arguments, each starting with a dash. */
  browserArgs?: string[]
  /**
   * `off` discards cookies and storage when the browser closes; `session`
   * saves them per Session; `shared` starts every Session from the most
   * recently saved state. Saved state is an unencrypted file in the user's
   * agent-browser directory.
   */
  restore?: BrowserRestore
  /** Maximum commands accepted by one call. */
  maxCommands?: number
  /** Cooperative timeout budget (ms) of one call, enforced through `exec.signal`. */
  timeoutMs?: number
  /** Maximum characters of one command's rendered result. */
  maxResultChars?: number
  /** Maximum bytes of CLI output one call will parse. */
  maxOutputBytes?: number
  /** Maximum bytes retained from the CLI's diagnostic output. */
  stderrMaxBytes?: number
  /** Terminate-escalation grace (ms) handed to the subprocess service. */
  graceMs?: number
  /** Deadline (ms) for closing one Session's browser when the plugin unloads. */
  closeTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  executablePath: z.string(),
  headed: z.boolean().default(false),
  browserArgs: z.array(z.string()).default([]),
  restore: z.union(['off', 'session', 'shared'] as const).default('off'),
  maxCommands: z.number().default(25),
  timeoutMs: z.number().default(180_000),
  maxResultChars: z.number().default(50_000),
  maxOutputBytes: z.number().default(8 * 1024 * 1024),
  stderrMaxBytes: z.number().default(16 * 1024),
  graceMs: z.number().default(3_000),
  closeTimeoutMs: z.number().default(5_000),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Omit<Config, 'executablePath'>> & Pick<Config, 'executablePath'>

/** Non-serializable seams that let tests replace the CLI program, host facts, and output root. */
export interface BrowserInternals {
  /**
   * Resolve the CLI program and any leading arguments.
   * @returns the argument vector that precedes the CLI's own arguments.
   */
  program?: () => readonly string[]
  /** Host facts used to choose the browser executable and platform launch arguments. */
  host?: BrowserHost
  /** Directory under which each Session's browser output directory is created. */
  outputRoot?: string
}

/**
 * Chrome relaunches itself without elevation when an elevated process starts
 * it with a visible window; the CLI then loses the browser it launched.
 */
const WINDOWS_LAUNCH_ARGS: readonly string[] = ['--do-not-de-elevate']

/** Saved-state key every Session loads under `restore: shared`. */
const SHARED_RESTORE_KEY = 'shared'

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-browser: ${field} must be a positive integer`)
  }
}

function validateConfig(config: ResolvedConfig): void {
  assertPositiveInteger('maxCommands', config.maxCommands)
  assertPositiveInteger('timeoutMs', config.timeoutMs)
  assertPositiveInteger('maxResultChars', config.maxResultChars)
  assertPositiveInteger('maxOutputBytes', config.maxOutputBytes)
  assertPositiveInteger('stderrMaxBytes', config.stderrMaxBytes)
  assertPositiveInteger('graceMs', config.graceMs)
  assertPositiveInteger('closeTimeoutMs', config.closeTimeoutMs)
  if (config.graceMs > MAX_TIMER_DELAY_MS || config.closeTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-browser: graceMs and closeTimeoutMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (config.executablePath !== undefined && !isAbsolute(config.executablePath)) {
    throw new Error('tool-browser: executablePath must be absolute')
  }
  for (const argument of config.browserArgs) {
    // The CLI splits its launch-argument list at a comma that precedes a dash.
    if (!argument.startsWith('-') || /[\r\n]|,-/u.test(argument)) {
      throw new Error(`tool-browser: browserArgs entry ${JSON.stringify(argument)} must start with a dash and contain no line break or ",-"`)
    }
  }
}

/**
 * Name the CLI session of one owner. CLI session names admit only letters,
 * digits, hyphens, and underscores, so the owner id is hashed.
 */
function sessionName(owner: string): string {
  return `session-${createHash('sha256').update(owner).digest('hex').slice(0, 16)}`
}

/**
 * Register the `browser` tool and its prompt section, and close every
 * browser this instance started when the plugin unloads.
 * @param ctx - plugin context; registrations are effects scoped to this plugin.
 * @param config - resolved plugin configuration from schemastery.
 * @param internals - test seams for the CLI program, host facts, and output root.
 */
export function apply(ctx: Context, config: Config, internals: BrowserInternals = {}): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  validateConfig(resolved)
  const host = internals.host ?? { platform: process.platform, env: process.env, exists: existsSync }
  const outputRoot = internals.outputRoot ?? join(tmpdir(), 'dsh-browser')
  const browserArgs = [...host.platform === 'win32' ? WINDOWS_LAUNCH_ARGS : [], ...resolved.browserArgs]
  const executablePath = resolveBrowserExecutable(resolved.executablePath, host)
  // Agentless calls share one browser for the lifetime of this plugin instance.
  const agentlessOwner = randomUUID()
  /**
   * Sessions whose browser this instance may have started: the visibility
   * last set for each, and the output files already reported to it.
   */
  const sessions = new Map<string, { headed: boolean; files?: Set<string> }>()
  const resolveProgram = internals.program ?? resolveCliProgram
  let program: readonly string[] | undefined

  const invocation = (session: string, headed: boolean, signal: AbortSignal): CliInvocation => {
    // Resolving at the call keeps a missing binary a tool failure instead of a failed composition.
    program ??= resolveProgram()
    return {
      program,
      launch: {
        session,
        headed,
        browserArgs,
        ...executablePath === undefined ? {} : { executablePath },
        ...resolved.restore === 'off' ? {} : { restore: resolved.restore === 'shared' ? SHARED_RESTORE_KEY : session },
      },
      cwd: join(outputRoot, session),
      env: childEnvironment(host.env),
      limits: { maxOutputBytes: resolved.maxOutputBytes, stderrMaxBytes: resolved.stderrMaxBytes, graceMs: resolved.graceMs },
      signal,
    }
  }

  ctx.systemPrompt.section({
    name: `tool:${BROWSER_TOOL_NAME}`,
    order: ctx.systemPrompt.getSectionOrder('TOOL_BROWSER'),
    text: ({ scope }) => ctx.tools.get(BROWSER_TOOL_NAME, scope) === undefined
      ? ''
      : browserGuidance({ canReadImages: ctx.tools.get('read_image', scope) !== undefined, keepsLogins: resolved.restore !== 'off' }),
  })

  ctx.tools.register(defineTool({
    name: BROWSER_TOOL_NAME,
    description: BROWSER_TOOL_DESCRIPTION,
    parameters: {
      commands: {
        type: 'array',
        required: true,
        description: 'Browser commands in execution order. Each command is a list of strings: the command name, then each argument as its own string.',
        items: { type: 'array', items: { type: 'string' } },
      },
      headed: {
        type: 'boolean',
        description: 'true shows the browser window so the user can watch or act in it; false hides it. Omit to keep the current setting; changing it restarts the browser.',
      },
    },
    timeoutMs: resolved.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            description: 'One outcome for each command that ran, in order, ending at the first failure.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                command: { type: 'array', required: true, items: { type: 'string' } },
                success: { type: 'boolean', required: true },
                error: { type: 'string', description: 'The browser\'s failure message; present only when success is false.' },
                result: {
                  type: 'json',
                  description: 'The command\'s data. snapshot gives { snapshot }, the element list with refs as text; reads give keys such as url, title, text, value, or count; a command that saves a file gives { path }.',
                },
              },
            },
          },
          skipped: { type: 'integer', required: true, description: 'How many later commands did not run because one failed.' },
          files: {
            type: 'array',
            required: true,
            description: 'Absolute paths of files saved since the previous call: screenshots, PDFs, and finished downloads.',
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderOutput(value, resolved.maxResultChars) }],
    },
    async execute(args, exec): Promise<BrowserOutput> {
      const mode = ctx.get('sandboxPolicy')?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session }).mode
      const { commands, annotate } = liftAnnotation(admitCommands(args.commands, resolved.maxCommands, mode))
      const session = sessionName(exec.agent?.session.id ?? agentlessOwner)
      const state = sessions.get(session) ?? { headed: resolved.headed }
      sessions.set(session, state)
      if (args.headed !== undefined) state.headed = args.headed
      const run = invocation(session, state.headed, exec.signal)
      await mkdir(run.cwd, { recursive: true })
      // Files left by an earlier run of this Session are not this call's output.
      const known = state.files ??= new Set(await listSavedFiles(run.cwd))
      const report = anchorSavedPaths(await runBatch(ctx, run, commands, annotate), run.cwd)
      const files = await claimNewFiles(run.cwd, known)
      return { ...report, files: files.map(file => join(run.cwd, file)) }
    },
    presentCall: args => ({
      card: 'generic',
      title: summarizeCommands(args.commands),
      kind: 'fetch',
      rawInput: args.commands.map(displayCommand).join('\n'),
    }),
  }))

  ctx.effect(() => async () => {
    const started = [...sessions.entries()]
    sessions.clear()
    await Promise.all(started.map(async ([session, state]) => {
      try {
        await closeBrowser(ctx, invocation(session, state.headed, AbortSignal.timeout(resolved.closeTimeoutMs)))
      } catch (error: unknown) {
        // The daemon closes an idle hidden browser on its own; a visible one stays until the user closes it.
        ctx.logger.warn('tool-browser: could not close the browser of %s: %o', session, error)
      }
    }))
  }, 'tool-browser: close session browsers')
}
