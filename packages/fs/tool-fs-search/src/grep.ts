/**
 * The model-facing `grep` tool: search file contents with a ripgrep regular
 * expression. Execution spawns the packaged ripgrep binary
 * (`@vscode/ripgrep`) directly through the subprocess seam with a plain argv
 * vector using a fixed line-oriented `rg --json` command so file path, line
 * number, and line text parse without colon-splitting ambiguity — this module
 * owns the model-facing schema, argument validation, argv construction,
 * `--json` record parsing, per-line preview retention, match retention,
 * grouping, and formatting; process concerns stay behind `ctx.subprocess`.
 *
 * @module @deepseek-ai/dsh-tool-fs-search/grep
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, SearchResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import { ItemRetainer } from '@deepseek-ai/dsh-output-retention'
import type { RetainedItems } from '@deepseek-ai/dsh-output-retention'
import type { SpillRef } from '@deepseek-ai/dsh-spill'
import type { GrepContextLine, GrepMatch } from './search-core.ts'
import { SearchError, previewLine, retainGlobPaths, retainGrepMatches, runRipgrep, searchScopeArgs, toWorkdirRelative, trySaveFormattedResult } from './search-core.ts'
import { globSearchMeta, grepSearchMeta, searchViewFromMeta } from './presentation.ts'
import { acceptedDirectCallValue } from './direct-call.ts'

/**
 * Default cap on flat matches retained inline by one `grep` call (the
 * `grepMaxMatches` config), matching Claude Code's default `GrepTool`
 * `head_limit`.
 */
export const GREP_MAX_MATCHES = 250

/**
 * Default cap in bytes on one matched-line preview (the `grepMaxLineBytes`
 * config); the cut preserves UTF-8 boundaries.
 */
export const GREP_MAX_LINE_BYTES = 2000

/** Resolved grep-tool caps — plugin config after defaulting (see `Config` in index.ts). */
export interface GrepToolCaps {
  /** Max flat matches retained inline; later matches go to the formatted spill file. */
  maxMatches: number
  /** Max bytes retained per matched-line preview. */
  maxLineBytes: number
  /** Max bytes of serialized `presentationMeta`; trailing file groups drop past it. */
  maxMetaBytes: number
  /** Cap on the complete raw `rg` stdout the tool will parse. */
  rawOutputMaxBytes: number
  /** Terminate-escalation grace period (ms) for the search process. */
  graceMs: number
  /** Cap on the retained stderr diagnostic tail. */
  stderrMaxBytes: number
  /** Cooperative tool-call budget (ms) attached as `ToolDefinition.timeoutMs`. */
  timeoutMs: number
}

/** Validated `grep` arguments. */
export type GrepOutputMode = 'content' | 'files' | 'count'

export interface GrepFileCount {
  path: string
  count: number
}

export type GrepResult = { matches: GrepMatch[] } | { files: string[] } | { counts: GrepFileCount[] }

export interface GrepInput {
  pattern: string
  path?: string
  include?: string | string[]
  ignoreCase?: boolean
  multiline?: boolean
  contextLines?: number
  outputMode?: GrepOutputMode
}

/** Upper bound on `contextLines`, keeping one match's block small. */
export const GREP_MAX_CONTEXT_LINES = 10

/**
 * Reject an `include` that is not ONE positive glob filter: blank strings,
 * negated patterns (`!…`), and comma-separated lists. A comma inside a brace
 * group is fine — `*.{ts,tsx}` is one glob with alternation, not a list.
 */
function validateInclude(include: string): void {
  if (include.trim().length === 0) throw new Error('include must be a non-empty glob when given')
  if (include.startsWith('!')) throw new Error('include must be a positive glob filter; negated patterns ("!…") are not supported')
  let braceDepth = 0
  for (const char of include) {
    if (char === '{') braceDepth++
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (char === ',' && braceDepth === 0) {
      throw new Error('include must be one glob, not a comma-separated list (use {a,b} alternation instead)')
    }
  }
}

/**
 * Validate value constraints the schema DSL can't express: a non-EMPTY
 * `pattern` (whitespace is a legitimate regex), a non-blank `path` when given,
 * and a single positive `include` glob ({@link GrepInput}). Throws a plain
 * `Error` (an ordinary tool argument error) otherwise.
 *
 * @param args - the schema-validated `grep` arguments.
 * @returns the accepted input, unchanged.
 */
export function parseGrepArgs(args: { pattern: string; path?: string; include?: string | string[]; ignoreCase?: boolean; multiline?: boolean; contextLines?: number; outputMode?: GrepOutputMode }): GrepInput {
  if (args.pattern.length === 0) throw new Error('pattern must be a non-empty string')
  if (args.contextLines !== undefined && (!Number.isInteger(args.contextLines) || args.contextLines < 0 || args.contextLines > GREP_MAX_CONTEXT_LINES)) {
    throw new Error(`contextLines must be an integer from 0 to ${GREP_MAX_CONTEXT_LINES}`)
  }
  if (args.path !== undefined && args.path.trim().length === 0) throw new Error('path must be a non-empty string when given')
  if (args.include !== undefined) {
    if (Array.isArray(args.include) && args.include.length === 0) throw new Error('include must contain at least one glob when given as an array')
    for (const include of Array.isArray(args.include) ? args.include : [args.include]) validateInclude(include)
  }
  return {
    pattern: args.pattern,
    ...args.path !== undefined ? { path: args.path } : {},
    ...args.include !== undefined ? { include: args.include } : {},
    ...args.ignoreCase === true ? { ignoreCase: true } : {},
    ...args.multiline === true ? { multiline: true } : {},
    ...args.contextLines !== undefined && args.contextLines > 0 ? { contextLines: args.contextLines } : {},
    ...args.outputMode !== undefined && args.outputMode !== 'content' ? { outputMode: args.outputMode } : {},
  }
}

/**
 * Build the fixed line-oriented `rg --json` argv for one `grep` call. Every
 * model-controlled value ({@link GrepInput.pattern}, {@link GrepInput.path},
 * {@link GrepInput.include}) is a plain argv element — no shell layer exists,
 * so no quoting applies; the pattern and include ride in `--flag=value` form
 * and the target behind `--`, so a leading-dash value can never be parsed as
 * a flag.
 *
 * @param input - the validated arguments.
 * @returns the complete ripgrep argument vector (excluding the binary itself).
 */
export function buildGrepCommand(input: GrepInput): string[] {
  const parts = ['--json', `--regexp=${input.pattern}`]
  if (input.ignoreCase === true) parts.push('--ignore-case')
  if (input.multiline === true) parts.push('--multiline')
  if (input.contextLines !== undefined) parts.push(`--context=${input.contextLines}`)
  if (input.include !== undefined) {
    for (const include of Array.isArray(input.include) ? input.include : [input.include]) parts.push(`--glob=${include}`)
  }
  parts.push(...searchScopeArgs())
  if (input.path !== undefined) parts.push('--', input.path)
  return parts
}

/**
 * The uniform malformed-output failure: raw `rg --json` is an internal
 * transport, so missing or invalid response fields cause a search failure, not a partial result.
 */
function malformedRecord(detail: string, cause?: unknown): SearchError {
  return new SearchError(`grep received malformed ripgrep --json output (${detail})`, 'SEARCH_FAILED', cause !== undefined ? { cause } : undefined)
}

/**
 * Parse one `rg --json` NDJSON line into a match, `undefined` for the
 * non-match record types (`begin`/`end`/`context`/`summary`). A line that is
 * not JSON, or a `match` record missing its path / line number / line content,
 * throws {@link SearchError} `SEARCH_FAILED`. A match whose line is not valid
 * UTF-8 (ripgrep sends base64 `bytes` instead of `text`) yields a placeholder
 * preview rather than failing the whole search.
 */
function parseRecord(line: string, withContext: boolean): (GrepMatch & { isContext: boolean }) | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error: unknown) {
    throw malformedRecord('a line is not JSON', error)
  }
  if (typeof parsed !== 'object' || parsed === null) throw malformedRecord('a record is not an object')
  const record = parsed as { type?: unknown; data?: unknown }
  // Framing record types (begin/end/summary — and any future type) are not
  // results: skipped, not malformed. `context` records are consumed only when
  // the caller asked for context lines.
  const isContext = record.type === 'context'
  if (record.type !== 'match' && !(isContext && withContext)) return undefined
  if (typeof record.data !== 'object' || record.data === null) throw malformedRecord('a match record has no data')
  const data = record.data as { path?: unknown; line_number?: unknown; lines?: unknown }
  const pathText = typeof data.path === 'object' && data.path !== null ? (data.path as { text?: unknown }).text : undefined
  if (typeof pathText !== 'string') throw malformedRecord('a match record has no path text')
  if (typeof data.line_number !== 'number') throw malformedRecord('a match record has no line number')
  if (typeof data.lines !== 'object' || data.lines === null) throw malformedRecord('a match record has no line content')
  const lines = data.lines as { text?: unknown; bytes?: unknown }
  if (typeof lines.text === 'string') {
    return { path: pathText, lineNumber: data.line_number, line: lines.text.replace(/\r?\n$/, ''), isContext }
  }
  if (typeof lines.bytes === 'string') {
    return { path: pathText, lineNumber: data.line_number, line: '(line is not valid UTF-8)', isContext }
  }
  throw malformedRecord('a match record has neither line text nor bytes')
}

/**
 * Parse complete `rg --json` stdout into flat matches, in output order (ripgrep
 * emits one file's matches contiguously). With `contextLines`, `context`
 * records attach to the nearest match: a line within `contextLines` after the
 * previous match of the same file is that match's `after`; any other pending
 * context line is the next match's `before`.
 *
 * @param stdout - the complete raw `rg --json` stdout.
 * @param contextLines - the `--context` width the search ran with; omit to ignore context records.
 * @returns the flat matches; empty for output with no match records.
 */
export function parseGrepMatches(stdout: string, contextLines?: number): GrepMatch[] {
  const matches: GrepMatch[] = []
  let pending: GrepContextLine[] = []
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    const record = parseRecord(line, contextLines !== undefined)
    if (record === undefined) continue
    const { isContext, ...entry } = record
    const previous = matches.at(-1)
    if (isContext) {
      const item = { lineNumber: entry.lineNumber, line: entry.line }
      if (previous !== undefined && previous.path === entry.path && entry.lineNumber > previous.lineNumber
        && entry.lineNumber - previous.lineNumber <= (contextLines ?? 0)) {
        previous.after = [...previous.after ?? [], item]
      } else pending.push(item)
      continue
    }
    if (pending.length > 0) entry.before = pending
    pending = []
    matches.push(entry)
  }
  return matches
}

export function grepFileCounts(matches: readonly GrepMatch[]): GrepFileCount[] {
  const counts = new Map<string, number>()
  for (const match of matches) counts.set(match.path, (counts.get(match.path) ?? 0) + 1)
  return Array.from(counts, ([path, count]) => ({ path, count }))
}

function retainCounts(counts: GrepFileCount[], maxItems: number): RetainedItems<GrepFileCount> {
  const retainer = new ItemRetainer<GrepFileCount>({ kind: 'head', maxItems })
  for (const count of counts) retainer.push(count)
  return retainer.finish()
}

function formatGrepFiles(retained: RetainedItems<string>, spillRef?: SpillRef): string {
  if (retained.seen === 0) return 'No matches found'
  const header = retained.truncated ? `Showing ${retained.kept} of ${retained.seen} files with matches` : `Found ${retained.seen} ${retained.seen === 1 ? 'file' : 'files'} with matches`
  const recovery = spillRef !== undefined ? `\n\n(Full grep result stored at: ${spillRef.locator}. ${spillRef.retrievalHint})` : ''
  return `${header}\n\n${retained.items.join('\n')}${recovery}`
}

function formatGrepCounts(retained: RetainedItems<GrepFileCount>, total: number, spillRef?: SpillRef): string {
  if (total === 0) return 'No matches found'
  const files = retained.seen
  const header = retained.truncated ? `Showing ${retained.kept} of ${files} files; ${total} ${matchNoun(total)} total` : `Found ${total} ${matchNoun(total)} in ${files} ${files === 1 ? 'file' : 'files'}`
  const recovery = spillRef !== undefined ? `\n\n(Full grep result stored at: ${spillRef.locator}. ${spillRef.retrievalHint})` : ''
  return `${header}\n\n${retained.items.map(item => `${item.path}: ${item.count}`).join('\n')}${recovery}`
}

/** `match` / `matches` for a count. */
function matchNoun(count: number): string {
  return count === 1 ? 'match' : 'matches'
}

/**
 * Group flat matches by file (first-seen order) into the model-facing body:
 * each file's display path, then one `Line N: <text>` row per match.
 *
 * @param matches - the flat matches to render.
 * @returns the grouped body text.
 */
export function formatGrepMatches(matches: GrepMatch[]): string {
  const byFile = new Map<string, GrepMatch[]>()
  for (const match of matches) {
    const group = byFile.get(match.path)
    if (group !== undefined) group.push(match)
    else byFile.set(match.path, [match])
  }
  const sections: string[] = []
  for (const [path, group] of byFile) {
    const rows = group.flatMap(m => [
      ...(m.before ?? []).map(c => `Line ${c.lineNumber}- ${c.line}`),
      `Line ${m.lineNumber}: ${m.line}`,
      ...(m.after ?? []).map(c => `Line ${c.lineNumber}- ${c.line}`),
    ])
    sections.push(`${path}\n${rows.join('\n')}`)
  }
  return sections.join('\n\n')
}

/**
 * Format the model-facing `grep` result: a found-count header, the retained
 * matches grouped by file, then — when the result was capped — a footer
 * carrying either the formatted-spill recovery locator or the could-not-save
 * explanation. The omitted count is a budget fact: the search itself completed.
 *
 * @param retained - the retention outcome over every parsed match.
 * @param spillRef - the saved complete-result reference, or `undefined` when unsaved.
 * @returns the model-facing text.
 */
export function formatGrepOutput(retained: RetainedItems<GrepMatch>, spillRef: SpillRef | undefined): string {
  const header = retained.truncated
    ? `Found ${retained.kept} of ${retained.seen} matches`
    : `Found ${retained.seen} ${matchNoun(retained.seen)}`
  const body = formatGrepMatches(retained.items)
  if (!retained.truncated) return `${header}\n\n${body}`
  const recovery = spillRef !== undefined
    ? `Full grep result stored at: ${spillRef.locator}. ${spillRef.retrievalHint}`
    : 'The complete result could not be saved; narrow pattern, path, or include to see more.'
  return `${header}\n\n${body}\n\n(${recovery})`
}

function renderGrepResult(value: GrepResult, caps: GrepToolCaps, spillRef?: SpillRef): string {
  if ('matches' in value) return formatRetainedGrep(retainGrepMatches(value.matches, caps.maxMatches, caps.maxLineBytes), spillRef)
  if ('files' in value) return formatGrepFiles(retainGlobPaths(value.files, caps.maxMatches), spillRef)
  return formatGrepCounts(retainCounts(value.counts, caps.maxMatches), value.counts.reduce((sum, item) => sum + item.count, 0), spillRef)
}

/** Format one already-retained match list for the Native surface. */
function formatRetainedGrep(retained: RetainedItems<GrepMatch>, spillRef?: SpillRef): string {
  if (retained.seen === 0) return 'No matches found'
  return formatGrepOutput(retained, spillRef)
}

/**
 * Pending-call presentation: a search card titled by the pattern (and target /
 * include filter).
 *
 * @param args - the raw tool arguments; `pattern`, `path`, and `include` feed the title.
 * @returns the generic card view (`kind: 'search'`) shown while the call runs.
 */
export function presentGrepCall(args: { pattern: string; path?: string; include?: string | string[] }): GenericCallView {
  const where = args.path !== undefined ? ` in ${args.path}` : ''
  const filter = args.include !== undefined ? ` (${Array.isArray(args.include) ? args.include.join(', ') : args.include})` : ''
  return { card: 'generic', title: `Grep ${args.pattern}${where}${filter}`, kind: 'search', rawInput: args.pattern }
}

/**
 * Completed-call presentation: the search card projected from the result's
 * `presentationMeta` (matches grouped by file, with the truncation signal). A UI
 * without a search card falls back to the raw `tool/result` content, so the view
 * carries no result text of its own. Malformed or absent metadata (an obsolete or
 * hand-edited replayed log) falls back to the generic card.
 *
 * @param _args - the raw tool arguments; unused, the view derives from the result.
 * @param result - the final model-facing tool result carrying the projected metadata.
 * @returns the search card view, or `undefined` for the generic fallback.
 */
export function presentGrepResult(
  _args: { pattern: string; path?: string; include?: string | string[]; outputMode?: GrepOutputMode },
  result: ToolResult,
): SearchResultView | undefined {
  if (result.isError) return undefined
  const view = searchViewFromMeta(result.meta)
  if (view === undefined || (view.shape !== 'matches' && view.shape !== 'paths')) return undefined
  return view
}

/**
 * Register the `grep` tool and its scope-aware system-prompt guidance.
 *
 * @param ctx - the plugin context; registrations are effects scoped to it, and
 *   execution uses its `subprocess` service.
 * @param caps - the deployment's resolved grep caps (plugin config after defaulting).
 */
export function applyGrepTool(ctx: Context, caps: GrepToolCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:grep',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GREP'),
    text: ({ scope }) => ctx.tools.get('grep', scope) === undefined
      ? ''
      : 'Use the grep tool — not shell grep or rg — to search file contents.'
        + (ctx.tools.get('read', scope) === undefined ? '' : ' Use read on a matched file when you need surrounding context.'),
  })

  const tool = defineTool({
    name: 'grep',
    description: 'Search file contents with a ripgrep regular expression, including hidden and ignored files but skipping VCS metadata, node_modules, dist, and target. Returns matching lines with line numbers, grouped by file. '
      + `Returns up to ${caps.maxMatches} matches; a larger result reports where the complete match list was saved.`,
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regular expression to search for (ripgrep syntax).' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the session workspace; a relative path resolves against it.' },
      include: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'One glob or an array of globs for which files to search (e.g. "*.ts", ["*.ts", "*.tsx"]). Negation and comma-separated strings are not supported.' },
      ignoreCase: { type: 'boolean', description: 'Match case-insensitively. Defaults to false.' },
      multiline: { type: 'boolean', description: 'Let the pattern match across line breaks ("." also matches a newline). Defaults to false.' },
      contextLines: { type: 'integer', description: `Unmatched lines to show before and after each match (0-${GREP_MAX_CONTEXT_LINES}); shown as "Line N- text". Defaults to 0.` },
      outputMode: { type: 'string', enum: ['content', 'files', 'count'], description: 'content returns matching lines (default), files returns each matching file once, count returns each file and its match count.' },
    },
    timeoutMs: caps.timeoutMs,
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              matches: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true },
                    lineNumber: { type: 'integer', required: true },
                    line: { type: 'string', required: true },
                    before: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { lineNumber: { type: 'integer', required: true }, line: { type: 'string', required: true } } } },
                    after: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { lineNumber: { type: 'integer', required: true }, line: { type: 'string', required: true } } } },
                  },
                },
              },
            },
          },
          { type: 'object', additionalProperties: false, properties: { files: { type: 'array', required: true, items: { type: 'string' } } } },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              counts: {
                type: 'array',
                required: true,
                items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, count: { type: 'integer', required: true } } },
              },
            },
          },
        ],
      },
      render: (_args, value) => [{ type: 'text', text: renderGrepResult(value, caps) }],
      presentationMeta: (_args, value) => {
        if ('matches' in value) return grepSearchMeta(retainGrepMatches(value.matches, caps.maxMatches, caps.maxLineBytes), caps.maxMetaBytes)
        if ('files' in value) {
          const retained = retainGlobPaths(value.files, caps.maxMatches)
          return globSearchMeta(retained, caps.maxMetaBytes)
        }
        return null
      },
    },
    async execute(args, exec) {
      const input = parseGrepArgs(args)
      const run = await runRipgrep(ctx, exec, 'grep', buildGrepCommand(input), caps.rawOutputMaxBytes, caps.graceMs, caps.stderrMaxBytes)
      if (run.noMatches) return input.outputMode === 'files' ? { files: [] } : input.outputMode === 'count' ? { counts: [] } : { matches: [] }

      const all: GrepMatch[] = []
      for (const raw of parseGrepMatches(run.stdout, input.contextLines)) {
        const match: GrepMatch = {
          path: toWorkdirRelative(raw.path, run.workdir),
          lineNumber: raw.lineNumber,
          line: raw.line,
          ...raw.before !== undefined ? { before: raw.before } : {},
          ...raw.after !== undefined ? { after: raw.after } : {},
        }
        all.push(match)
      }
      if (input.outputMode === 'files') return { files: [...new Set(all.map(match => match.path))] }
      if (input.outputMode === 'count') return { counts: grepFileCounts(all) }
      return { matches: all }
    },
    presentCall: presentGrepCall,
    presentResult: presentGrepResult,
  })
  ctx.tools.register(tool)

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const value = acceptedDirectCallValue(ctx, tool, exec, result, decision) as GrepResult | undefined
    if (value === undefined) return decision
    const count = 'matches' in value ? value.matches.length : 'files' in value ? value.files.length : value.counts.length
    if (count <= caps.maxMatches) return decision
    const complete = 'matches' in value
      ? `Found ${value.matches.length} ${matchNoun(value.matches.length)}\n\n${formatGrepMatches(value.matches.map(match => ({ ...match, line: previewLine(match.line, caps.maxLineBytes) })))}`
      : 'files' in value ? value.files.join('\n') : value.counts.map(item => `${item.path}: ${item.count}`).join('\n')
    const spillRef = await trySaveFormattedResult(ctx, exec, 'grep-results.txt', complete)
    return {
      kind: 'accept',
      content: [{ type: 'text', text: renderGrepResult(value, caps, spillRef) }],
      ...decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {},
    }
  })
}
