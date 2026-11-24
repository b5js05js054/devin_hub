/** Whole-turn review: reject restores every file of a turn from its served diff, accept adopts the disk text. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { readText } from './face.ts'
import { revertHunks } from './revert.ts'

/** The slice of the served comparison that reverting needs. */
export type TurnDiff = {
  readonly kind: string
  readonly before?: boolean
  readonly after?: boolean
  readonly hunks?: readonly { readonly newStart: number; readonly newLines: number; readonly lines: readonly string[] }[]
} | undefined

/** One file of the turn. */
export interface TurnFile {
  readonly path: string
  readonly display: string
}

/**
 * Resolve a summary path against the Session's working directory.
 * @param cwd - the Session's working directory.
 * @param path - the summary path, absolute or relative.
 * @returns the absolute workspace path the IDE tracks the file under.
 */
export function turnPath(cwd: string | undefined, path: string): string {
  return /^([a-zA-Z]:)?[\\/]/.test(path) || cwd === undefined ? path : `${cwd.replace(/[/\\]+$/, '')}/${path}`
}

/** Result of a reject: the restored files, or the blocking file plus whichever files were already written back. */
export type RejectResult =
  | { readonly restored: readonly { readonly path: string; readonly text: string }[] }
  | { readonly failed: string; readonly written: readonly { readonly path: string; readonly text: string }[] }

/**
 * Restore every file of a turn to its content before the turn.
 * All files are checked against their current disk text first; when any cannot be restored, nothing is written.
 * A write failing midway reports that file, and earlier files stay restored.
 * @param remote - the Client Remote carrying `workspaceFiles`.
 * @param sessionId - Session owning the workspace.
 * @param cwd - the Session's working directory, used to resolve relative paths.
 * @param files - the turn's changed files in summary order.
 * @param readDiff - reads one file's comparison by summary index.
 * @returns the restored files, or the first file that blocked the restore.
 */
export async function rejectTurn(
  remote: ClientRemote, sessionId: SessionId, cwd: string | undefined, files: readonly TurnFile[],
  readDiff: (index: number) => Promise<TurnDiff>,
): Promise<RejectResult> {
  const plan: { display: string; path: string; text: string; body: string; version: string }[] = []
  for (const [index, file] of files.entries()) {
    const diff = await readDiff(index)
    if (diff?.kind !== 'text' || diff.before !== true || diff.after !== true || diff.hunks === undefined) return { failed: file.display, written: [] }
    const path = turnPath(cwd, file.path)
    const current = await readText(remote, sessionId, path)
    if (!current.ok) return { failed: file.display, written: [] }
    const text = revertHunks(current.value.text, diff.hunks)
    if (text === undefined) return { failed: file.display, written: [] }
    plan.push({ display: file.display, path, text, body: current.value.finalNewline && text !== '' ? `${text}\n` : text, version: current.value.version })
  }
  const written: { path: string; text: string }[] = []
  for (const step of plan) {
    const result = await remote.workspaceFiles.write(sessionId, step.path, step.body, step.version, new AbortController().signal)
    if (!result.ok) return { failed: step.display, written }
    written.push({ path: step.path, text: step.text })
  }
  return { restored: written }
}
