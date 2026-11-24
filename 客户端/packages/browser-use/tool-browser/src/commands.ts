/**
 * Admission rules for the commands a model sends to the browser tool. The CLI
 * also administers its own host, so a command is admitted only when it
 * operates the session's browser, and file-saving commands follow the
 * session's sandbox mode because the CLI process itself is not confined.
 * @module @deepseek-ai/dsh-tool-browser/commands
 */

import { posix, win32 } from 'node:path'
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { BrowserToolError } from './errors.ts'

/** The CLI's own program name, which models often repeat as the first argument. */
const CLI_NAME = 'agent-browser'

const NOT_A_PAGE_OPERATION = 'it does not operate a page'

/** CLI commands that change the host or leave the session's browser, with the reason shown to the model. */
const DENIED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ['install', 'installing a browser is a deployment task; ask the user to install Google Chrome or Microsoft Edge'],
  ['upgrade', 'the browser tool is updated together with the application'],
  ['connect', 'the tool controls only the browser it starts for this session'],
  ['batch', 'pass the commands directly in `commands`'],
  ['mcp', NOT_A_PAGE_OPERATION],
  ['chat', NOT_A_PAGE_OPERATION],
  ['dashboard', NOT_A_PAGE_OPERATION],
  ['stream', NOT_A_PAGE_OPERATION],
  ['plugin', NOT_A_PAGE_OPERATION],
  ['skills', NOT_A_PAGE_OPERATION],
])

/** Options that widen an admitted command beyond the session's own browser, with the reason shown to the model. */
const DENIED_OPTIONS: ReadonlyMap<string, readonly [option: string, reason: string]> = new Map([
  ['close', ['--all', 'it would close browsers that belong to other sessions']],
  ['doctor', ['--fix', 'repairs change the host installation']],
])

/**
 * The `state` operations that export or import this session's cookies and
 * storage. The CLI's other `state` operations list, rename, and delete the
 * saved logins of every session at once.
 */
const SESSION_STATE_OPERATIONS: ReadonlySet<string | undefined> = new Set(['save', 'load'])

/** The screenshot option the CLI accepts for a whole invocation but not inside one command. */
const ANNOTATE_OPTION = '--annotate'

/**
 * Whether a command writes a file the caller names.
 * @param command - one admitted command, name first.
 * @returns true for capture, download, recording, and state-export commands.
 */
function savesFiles(command: readonly string[]): boolean {
  switch (command[0]) {
    case 'screenshot':
    case 'pdf':
    case 'download':
    case 'trace':
    case 'profiler':
    case 'record':
      return true
    case 'state': return command[1] === 'save'
    case 'network': return command[1] === 'har'
    case 'wait': return command.includes('--download')
    default: return false
  }
}

/** Whether an argument can name a location outside the directory the CLI runs in. */
function leavesWorkingDirectory(argument: string): boolean {
  return posix.isAbsolute(argument) || win32.isAbsolute(argument) || argument.split(/[\\/]/u).includes('..')
}

/**
 * Validate and normalize one call's commands before anything runs.
 * @param commands - the model's commands, each an argument vector.
 * @param maxCommands - the deployment's per-call command limit.
 * @param mode - the session's standing sandbox mode; `undefined` when the composition mounts no sandbox policy.
 * @returns the commands to run, with a repeated leading program name removed.
 * @throws BrowserToolError naming the first rejected command by its 1-based position.
 */
export function admitCommands(
  commands: readonly (readonly string[])[],
  maxCommands: number,
  mode: SandboxMode | undefined,
): string[][] {
  if (commands.length === 0) {
    throw new BrowserToolError('commands must contain at least one command', 'BROWSER_INVALID_COMMAND')
  }
  if (commands.length > maxCommands) {
    throw new BrowserToolError(
      `commands accepts at most ${maxCommands} commands per call, received ${commands.length}; split the work across calls`,
      'BROWSER_INVALID_COMMAND',
    )
  }
  return commands.map((raw, index) => {
    const position = `command ${index + 1}`
    const command = raw[0] === CLI_NAME ? raw.slice(1) : [...raw]
    const name = command[0]
    if (name === undefined || name.trim().length === 0) {
      throw new BrowserToolError(`${position} is empty; start it with a command name such as "open" or "snapshot"`, 'BROWSER_INVALID_COMMAND')
    }
    if (name.startsWith('-')) {
      throw new BrowserToolError(
        `${position} starts with the option ${JSON.stringify(name)}; start it with the command name and put options after it. Browser-wide settings come from the tool's own parameters`,
        'BROWSER_INVALID_COMMAND',
      )
    }
    const denial = DENIED_COMMANDS.get(name)
    if (denial !== undefined) {
      throw new BrowserToolError(`${position}: "${name}" is not available through this tool: ${denial}`, 'BROWSER_COMMAND_DENIED')
    }
    const option = DENIED_OPTIONS.get(name)
    if (option !== undefined && command.includes(option[0])) {
      throw new BrowserToolError(`${position}: "${name} ${option[0]}" is not available through this tool: ${option[1]}`, 'BROWSER_COMMAND_DENIED')
    }
    if (name === 'state' && !SESSION_STATE_OPERATIONS.has(command[1])) {
      throw new BrowserToolError(
        `${position}: "${command.slice(0, 2).join(' ')}" is not available through this tool: it manages the saved logins of every session. `
        + 'Use "state save <file>" or "state load <file>" for this session, and "cookies clear" to sign this session out',
        'BROWSER_COMMAND_DENIED',
      )
    }
    if (mode !== undefined && mode !== 'danger-full-access' && savesFiles(command)) {
      const outside = command.slice(1).find(leavesWorkingDirectory)
      if (outside !== undefined) {
        throw new BrowserToolError(
          `${sandboxDenialMarker(mode)}\n${position}: "${name}" may not save to ${JSON.stringify(outside)} in this mode. `
          + 'Use a plain file name, which is saved in the browser\'s own output directory and reported in the result, or omit the path.',
          'BROWSER_SANDBOX_DENIED',
        )
      }
    }
    return command
  })
}

/**
 * Separate the screenshot annotation option from the commands, because the
 * CLI rejects it inside a command and takes it for the whole invocation.
 * @param commands - admitted commands.
 * @returns the commands without the option, and whether any screenshot asked for it.
 */
export function liftAnnotation(commands: readonly string[][]): { commands: string[][]; annotate: boolean } {
  let annotate = false
  const lifted = commands.map((command) => {
    if (command[0] !== 'screenshot' || !command.includes(ANNOTATE_OPTION)) return command
    annotate = true
    return command.filter(argument => argument !== ANNOTATE_OPTION)
  })
  return { commands: lifted, annotate }
}
