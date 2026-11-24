import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { WorkspaceSearchRequest, WorkspaceSearchResult, WorkspaceSearchMatch } from './types.ts'

const SKIPPED_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', '.next', 'coverage'])

function pathOf(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`
}
export interface WorkspaceSearchLimits {
  readonly maxDirectories: number
  readonly maxEntries: number
  readonly maxResults: number
  readonly maxFileBytes: number
}

/** Bounded workspace discovery for the IDE, using the provider in its own execution world. */
export async function searchWorkspace(ctx: Context, root: FsTarget, workspaceRoot: string, request: WorkspaceSearchRequest, limits: WorkspaceSearchLimits, signal: AbortSignal): Promise<WorkspaceSearchResult> {
  const query = request.query.trim()
  if (query === '' || query.length > 512 || query.includes('\0') || query.includes('\n') || query.includes('\r')) {
    throw new RemoteError('gateway/bad-request', 'query must be 1-512 non-empty characters on one line', {})
  }
  const limit = request.limit ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > limits.maxResults) {
    throw new RemoteError('gateway/bad-request', `limit must be a safe integer between 1 and ${limits.maxResults}`, {})
  }
  const folded = request.kind === 'files' || request.ignoreCase === true ? query.toLocaleLowerCase() : query
  const matches: WorkspaceSearchMatch[] = []
  const pending: Array<{ target: FsTarget; path: string }> = [{ target: root, path: '' }]
  // `truncated` means the result may be incomplete: a limit was reached or an entry that could be searched was unreadable.
  let truncated = false
  let directories = 0
  let entries = 0
  while (pending.length > 0) {
    signal.throwIfAborted()
    if (directories >= limits.maxDirectories) { truncated = true; break }
    directories++
    const directory = pending.shift()!
    let children
    try {
      children = await ctx.fs.listDir(directory.target, signal)
    } catch (error: unknown) {
      // A cancelled listing must surface as cancellation; any other failure leaves this directory unsearched.
      signal.throwIfAborted()
      truncated = true
      continue
    }
    for (const child of children) {
      if (entries >= limits.maxEntries) { truncated = true; break }
      entries++
      if (child.type === 'other' || !ctx.fs.contains(root, child.target)) continue
      // Resolved child types follow links; only the path-level probe can refuse them.
      let info
      try {
        info = await ctx.fs.lstat(pathOf(directory.path, child.name), { cwd: workspaceRoot }, signal)
      } catch (error: unknown) {
        // Cancellation propagates; an entry that cannot be probed is left unsearched.
        signal.throwIfAborted()
        truncated = true
        continue
      }
      if (info === undefined || info.type !== child.type) continue
      const path = directory.path === '' ? child.name : `${directory.path}/${child.name}`
      if (child.type === 'directory') {
        if (SKIPPED_DIRECTORIES.has(child.name)) continue
        pending.push({ target: child.target, path })
        continue
      }
      if (request.kind === 'files') {
        if (!child.name.toLocaleLowerCase().includes(folded)) continue
        matches.push({ absolutePath: ctx.fs.processPath(child.target), path })
      } else {
        if (child.size !== undefined && child.size > limits.maxFileBytes) { truncated = true; continue }
        let bytes: Uint8Array
        try {
          bytes = await ctx.fs.readBytes(child.target, signal, limits.maxFileBytes)
        } catch (error: unknown) {
          // Cancellation propagates; an unreadable or oversized file is left unsearched.
          signal.throwIfAborted()
          truncated = true
          continue
        }
        let text: string
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        } catch (error: unknown) {
          // Invalid UTF-8 means a binary file, which has no text lines to match.
          continue
        }
        if (text.includes('\0')) continue
        const lines = text.split('\n')
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index]!
          const haystack = request.ignoreCase === true ? line.toLocaleLowerCase() : line
          const column = haystack.indexOf(folded)
          if (column < 0) continue
          matches.push({ absolutePath: ctx.fs.processPath(child.target), path, line: index + 1, column: column + 1, text: line.length > 500 ? `${line.slice(0, 500)}…` : line })
          if (matches.length > limit) break
        }
      }
      if (matches.length > limit) { truncated = true; matches.length = limit; break }
    }
    if (truncated) break
  }
  return { matches, truncated }
}
