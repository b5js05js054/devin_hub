/**
 * The browser tool's canonical value: decoding the CLI's batch report into
 * it, and rendering it as model-facing text.
 * @module @deepseek-ai/dsh-tool-browser/render
 */

import { join, posix, win32 } from 'node:path'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { BrowserToolError } from './errors.ts'

/** The outcome of one browser command. */
export interface BrowserCommandResult {
  /** The command as run, name first. */
  command: string[]
  /** Whether the browser completed the command. */
  success: boolean
  /** The browser's failure text; present only on failure. */
  error?: string
  /** The command's data, such as a snapshot, a value read from the page, or a saved file path. */
  result?: JsonValue
}

/** The decoded outcomes of one CLI batch. */
export interface BatchReport {
  /** Outcomes in execution order, ending at the first failure. */
  results: BrowserCommandResult[]
  /** How many submitted commands did not run because an earlier one failed. */
  skipped: number
}

/** The canonical value of one browser tool call. */
export interface BrowserOutput extends BatchReport {
  /**
   * Absolute paths of the files that appeared in the session's output
   * directory since its previous call: screenshots, PDFs, and downloads,
   * including a download that finished between calls.
   */
  files: string[]
}

/** Result key reporting that the browser was restarted to run a command. */
const RESTARTED_KEY = 'browserRestarted'

/** Keys of a snapshot result that list, per ref, what the snapshot text already says. */
const SNAPSHOT_REF_TABLES: ReadonlySet<string> = new Set(['refs', 'removedRefs'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reduce one reported result to page data. The CLI attaches a `lifecycle`
 * record of daemon and launch bookkeeping to every result; only a browser
 * restart in it concerns the caller, because it discards pages and logins.
 */
function pageData(result: unknown): JsonValue | undefined {
  if (result === undefined || result === null) return undefined
  if (!isRecord(result)) return result as JsonValue
  const { lifecycle, ...reported } = result
  // A snapshot's text already carries every ref; the parallel ref tables repeat it.
  const data = typeof reported['snapshot'] === 'string'
    ? Object.fromEntries(Object.entries(reported).filter(([key]) => !SNAPSHOT_REF_TABLES.has(key)))
    : reported
  const restarted = isRecord(lifecycle) && lifecycle['relaunchedBrowser'] === true
  return { ...data, ...restarted ? { [RESTARTED_KEY]: true } : {} }
}

/**
 * Decode the CLI's `batch --json` report.
 * @param stdout - the complete standard output of one batch invocation.
 * @param submitted - how many commands the invocation was given.
 * @returns the outcomes, plus the count the CLI skipped after a failure.
 * @throws BrowserToolError `BROWSER_FAILED` when the output is not a batch report.
 */
export function parseBatchReport(stdout: string, submitted: number): BatchReport {
  let report: unknown
  try {
    report = JSON.parse(stdout)
  } catch (error: unknown) {
    throw new BrowserToolError('the browser returned output that is not a result report', 'BROWSER_FAILED', { cause: error })
  }
  if (!Array.isArray(report) || report.length > submitted) {
    throw new BrowserToolError('the browser returned a result report that does not match the submitted commands', 'BROWSER_FAILED')
  }
  const results = report.map((row: unknown, index): BrowserCommandResult => {
    if (!isRecord(row) || typeof row['success'] !== 'boolean'
      || !Array.isArray(row['command']) || !row['command'].every(part => typeof part === 'string')) {
      throw new BrowserToolError(`the browser returned a malformed result for command ${index + 1}`, 'BROWSER_FAILED')
    }
    const data = pageData(row['result'])
    return {
      command: row['command'],
      success: row['success'],
      ...row['success'] ? {} : { error: typeof row['error'] === 'string' ? row['error'] : 'the command failed without a message' },
      ...data === undefined ? {} : { result: data },
    }
  })
  return { results, skipped: submitted - results.length }
}

/**
 * Report saved files by absolute path. The browser echoes a relative file
 * argument as given, which names a location only inside its own working
 * directory.
 * @param report - decoded outcomes.
 * @param directory - the absolute directory the commands ran in.
 * @returns the outcomes with every relative `path` result resolved against `directory`.
 */
export function anchorSavedPaths(report: BatchReport, directory: string): BatchReport {
  return {
    ...report,
    results: report.results.map((entry) => {
      const { result } = entry
      if (!isRecord(result) || typeof result['path'] !== 'string') return entry
      const path = result['path']
      if (posix.isAbsolute(path) || win32.isAbsolute(path)) return entry
      return { ...entry, result: { ...result, path: join(directory, path) } }
    }),
  }
}

/** Quote an argument only when a reader could not tell where it ends. */
function displayArgument(argument: string): string {
  return argument.length === 0 || /\s/u.test(argument) ? JSON.stringify(argument) : argument
}

/**
 * Render one command as a single line.
 * @param command - the command's arguments, name first.
 * @returns the arguments joined by spaces, quoting those that contain whitespace.
 */
export function displayCommand(command: readonly string[]): string {
  return command.map(displayArgument).join(' ')
}

/** Render text as itself and any other value as JSON. */
function displayValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * Render one numbered label of an annotated screenshot with the ref it
 * marks. The pixel box the CLI also reports is already visible in the image.
 */
function renderLabel(label: JsonValue): string {
  if (!isRecord(label)) return `  ${displayValue(label)}`
  return `  [${displayValue(label['number'])}] @${displayValue(label['ref'])} ${displayValue(label['role'])} ${JSON.stringify(label['name'])}`
}

/** Render one successful command's data. */
function renderData(result: JsonValue | undefined): string {
  if (result === undefined) return 'ok'
  if (typeof result === 'string') return result
  if (!isRecord(result)) return JSON.stringify(result)
  const lines: string[] = []
  const { [RESTARTED_KEY]: restarted, ...data } = result
  if (restarted === true) lines.push('note: the browser restarted for this command; pages and logins from before are gone')
  if (typeof data['snapshot'] === 'string') {
    lines.push(data['snapshot'].length === 0 ? '(the page has no matching elements)' : data['snapshot'])
  } else {
    for (const [key, value] of Object.entries(data)) {
      // The debugging-protocol target id names nothing a later command needs; tabs have their own ids.
      if (key === 'targetId') continue
      if (key === 'annotations' && Array.isArray(value)) {
        lines.push('labels drawn on the image:', ...value.map(renderLabel))
        continue
      }
      lines.push(`${key}: ${displayValue(value)}`)
    }
  }
  return lines.length === 0 ? 'ok' : lines.join('\n')
}

/**
 * Render a call's outcomes for the model: one block per command, each body
 * bounded independently so an oversized page cannot hide later results.
 * @param output - the canonical value.
 * @param maxResultChars - the character budget of one command's body.
 * @returns the complete result text.
 */
export function renderOutput(output: BrowserOutput, maxResultChars: number): string {
  const blocks = output.results.map((entry) => {
    // `error` is present exactly on a failed command.
    const body = entry.error === undefined ? renderData(entry.result) : `Error: ${entry.error}`
    const bounded = body.length <= maxResultChars
      ? body
      : `${body.slice(0, maxResultChars)}\n[${body.length - maxResultChars} more characters omitted; narrow the request, for example with snapshot -i, snapshot -s <selector>, or get text <selector>]`
    return `$ ${displayCommand(entry.command)}\n${bounded}`
  })
  if (output.skipped > 0) {
    blocks.push(`(${output.skipped} later ${output.skipped === 1 ? 'command was' : 'commands were'} not run)`)
  }
  // A command that names its saved file already shows the path in its own block.
  const shown = new Set(output.results.map(entry => isRecord(entry.result) ? entry.result['path'] : undefined))
  const unshown = output.files.filter(file => !shown.has(file))
  if (unshown.length > 0) blocks.push(`Saved files:\n${unshown.join('\n')}`)
  return blocks.join('\n\n')
}

/**
 * Title a call for a UI card.
 * @param commands - the call's commands.
 * @returns the first command, plus a count of the rest.
 */
export function summarizeCommands(commands: readonly (readonly string[])[]): string {
  const [first, ...rest] = commands
  if (first === undefined) return 'browser'
  const head = displayCommand(first)
  return rest.length === 0 ? head : `${head} (+${rest.length} more)`
}
