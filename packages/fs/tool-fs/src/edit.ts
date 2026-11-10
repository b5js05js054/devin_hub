/**
 * Model-facing literal edit, unique-match by default. It obtains an optional guard from the
 * single intent slot, calls `ctx.fs.editText` without a separate stat, then records the observed
 * version; no policy means an unconditional atomic edit.
 * @module @deepseek-ai/dsh-tool-fs/src/edit
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DiffCallView, DiffResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type { FsEditStep } from '@deepseek-ai/dsh-fs'
import { computeHunkDiffs, diffsFromMeta } from './diff.ts'
import { remediateFsError } from './error.ts'
import { mutationResult } from './mutation-result.ts'
import { sessionResolveOptions } from './session-cwd.ts'
import type { FsSandboxController } from './sandbox.ts'

/** One follow-up replacement of a batch, as the model supplies it. */
interface MoreEdit {
  old_string: string
  new_string: string
  replace_all?: boolean
}

/** Validated `edit` arguments after defaulting. */
interface EditInput {
  filePath: string
  oldString: string
  newString: string
  replaceAll: boolean
  then: FsEditStep[]
}

/**
 * The `edit` tool's validated arguments: the base parameters plus the two
 * escalation fields, advertised only under a confining `ctx.fs` (absent from
 * the schema otherwise, so the validator rejects them before `execute`).
 */
interface EditToolArgs {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
  more_edits?: MoreEdit[]
  sandbox_permissions?: string
  justification?: string
}

/**
 * Validate value constraints the schema DSL can't express: a non-blank
 * `file_path`, and for every replacement (the primary one and each of
 * `more_edits`) a non-empty `old_string` that differs from `new_string`.
 * @param args - the schema-validated raw tool arguments.
 * @returns the camelCased input with `replace_all` defaulted to false and the follow-up steps in order.
 */
export function parseEditArgs(args: { file_path: string; old_string: string; new_string: string; replace_all?: boolean; more_edits?: MoreEdit[] }): EditInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const steps = [args, ...args.more_edits ?? []]
  steps.forEach((step, index) => {
    const label = index === 0 ? '' : ` (more_edits[${index - 1}])`
    if (step.old_string.length === 0) throw new Error(`old_string must be a non-empty string${label}`)
    if (step.old_string === step.new_string) throw new Error(`old_string and new_string must differ${label}`)
  })
  return {
    filePath: args.file_path,
    oldString: args.old_string,
    newString: args.new_string,
    replaceAll: args.replace_all ?? false,
    then: (args.more_edits ?? []).map(step => ({ oldString: step.old_string, newString: step.new_string, replaceAll: step.replace_all ?? false })),
  }
}

/**
 * Format an edit success (single-match or replace-all) as a Claude-style model-facing message.
 * @param displayPath - the backend-resolved path shown to the model.
 * @param replaceAll - selects the all-occurrences wording over the single-replacement one.
 * @returns the confirmation sentence the model sees as the tool result.
 */
export function formatEditOutput(displayPath: string, replaceAll: boolean): string {
  return replaceAll
    ? `The file ${displayPath} has been updated. All occurrences were successfully replaced.`
    : `The file ${displayPath} has been updated successfully.`
}

/** Lines of unchanged context shown around the edited region. */
const SNIPPET_CONTEXT = 3
/** Cap on snippet lines so a large replacement does not echo the whole block. */
const SNIPPET_MAX_LINES = 30

/**
 * Show the edited region of the new text with line numbers, so the model can verify the edit without re-reading.
 * @param before - the file text before the edit.
 * @param after - the file text after the edit.
 * @returns the numbered snippet, or an empty string when the texts do not differ.
 */
export function formatEditSnippet(before: string, after: string): string {
  if (before === after) return ''
  const max = Math.min(before.length, after.length)
  let start = 0
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++
  let tail = 0
  while (tail < max - start && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++
  const lines = after.split('\n')
  const firstLine = after.slice(0, start).split('\n').length - 1
  const lastLine = after.slice(0, after.length - tail).split('\n').length - 1
  const from = Math.max(firstLine - SNIPPET_CONTEXT, 0)
  const to = Math.min(lastLine + SNIPPET_CONTEXT, lines.length - 1)
  const shownTo = Math.min(to, from + SNIPPET_MAX_LINES - 1)
  const body = lines.slice(from, shownTo + 1).map((line, index) => `${from + index + 1}\t${line}`).join('\n')
  return `${body}${shownTo < to ? '\n...' : ''}`
}

/**
 * Register the `edit` tool and its scope-aware system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `fs` service.
 * @param sandbox - the shared sandbox-escalation API (advertisement, mode stamping, denial mapping).
 */
export function applyEditTool(ctx: Context, sandbox: FsSandboxController): void {
  ctx.systemPrompt.section({
    name: 'tool:edit',
    order: ctx.systemPrompt.getSectionOrder('TOOL_EDIT'),
    text: ({ scope }) => ctx.tools.get('edit', scope) === undefined
      ? ''
      : 'Read a file before editing it (the default fs-observation-policy requires it), unless you just created or edited it in this session.',
  })

  ctx.tools.register(defineTool({
    name: 'edit',
    description: 'Edit an existing UTF-8 text file by replacing literal text.',
    parameters: {
      file_path: {
        type: 'string', required: true,
        description: 'Path to edit, resolved by the filesystem backend. '
          + 'Provide `file_path` before `old_string` and `new_string` in the arguments.',
      },
      old_string: { type: 'string', required: true, description: 'Literal text to replace.' },
      new_string: { type: 'string', required: true, description: 'Literal replacement text. Use an empty string to delete the match.' },
      replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
      more_edits: {
        type: 'array',
        description: 'Further replacements in the same file, applied in order after the first one, each against the text the previous step produced. '
          + 'All succeed or none is written.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            old_string: { type: 'string', required: true, description: 'Literal text to replace.' },
            new_string: { type: 'string', required: true, description: 'Literal replacement text.' },
            replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false.' },
          },
        },
      },
      ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Canonical absolute path in the filesystem execution world.' },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
        },
      },
      render: (args, value) => {
        const snippet = formatEditSnippet(value.before, value.after)
        return [{
          type: 'text',
          text: `${formatEditOutput(value.path, args.replace_all ?? false)}${snippet === '' ? '' : `\nSnippet of the edited region (line<TAB>text):\n${snippet}`}`,
        }]
      },
      presentationMeta: (_args, value) => ({
        path: value.path,
        diffs: computeHunkDiffs(value.path, value.before, value.after)
          .map(({ path, oldText, newText }) => ({ path, oldText, newText })),
      }),
    },
    async execute(args: EditToolArgs, exec) {
      const input = parseEditArgs(args)
      // Resolve the per-call sandbox policy (approved mode > session override
      // > backend default, plus the session cwd root) BEFORE anything executes.
      const sandboxPolicy = await sandbox.resolvePolicy('edit', args, exec)
      const target = await ctx.fs.resolve(input.filePath, await sessionResolveOptions(ctx, exec))
      // Single-slot decision: the policy plugin returns { version: vObserved } or
      // throws FS_NOT_OBSERVED; the bare default is undefined (unconditional edit).
      // No stat — the bare default never manufactures a version basis. The intent
      // slot itself can throw FS_NOT_OBSERVED for an unread target, so it sits
      // inside the try: both that refusal and the provider's guarded-mutation
      // failure get the model-facing remedy below.
      let outcome
      try {
        const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
        outcome = await ctx.fs.editText(
          target,
          { oldString: input.oldString, newString: input.newString, replaceAll: input.replaceAll, ...input.then.length > 0 ? { then: input.then } : {} },
          intent,
          exec.signal,
          sandboxPolicy,
        )
      } catch (error: unknown) {
        // A sandbox denial becomes the shared [sandbox: …] marker (the model
        // recognizes it from bash); guarded mutation failures receive their
        // stable model-facing diagnostic; anything else passes through.
        throw remediateFsError(sandbox.mapError(error, sandboxPolicy), target.displayPath)
      }
      return mutationResult(ctx, target, outcome, exec)
    },
    // Pure display: a diff card of the literal replacement (old_string → new_string), derived
    // from the call args. `oldText: old_string || null` matches claude-agent-acp's Edit arm;
    // new_string is a required arg here, so it maps straight to newText.
    presentCall(args): DiffCallView {
      return {
        card: 'diff',
        title: `Edit ${args.file_path}`,
        diffs: [{ path: args.file_path, oldText: args.old_string || null, newText: args.new_string }],
        locations: [{ path: args.file_path }],
      }
    },
    // Applied metadata replaces the call-time snippet; errors or malformed replay metadata use
    // the generic result rendering.
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
      if (diffs === undefined) return undefined
      return { card: 'diff', title: `Edit ${args.file_path}`, diffs }
    },
  }))
}
