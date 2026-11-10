/** The slice of a served diff hunk that reverting needs. */
export interface RevertibleHunk {
  readonly newStart: number
  readonly newLines: number
  /** Unified-diff lines, each prefixed by ` `, `+` or `-`. */
  readonly lines: readonly string[]
}

/**
 * Undo a turn's hunks on the file's current text.
 * @param current - the file as it is on disk now.
 * @param hunks - the turn's hunks for this file, in served order.
 * @returns the text before the turn, or `undefined` when a hunk's new-side lines no longer match `current`.
 */
export function revertHunks(current: string, hunks: readonly RevertibleHunk[]): string | undefined {
  const lines = current.split('\n')
  for (const hunk of [...hunks].sort((a, b) => b.newStart - a.newStart)) {
    const after = hunk.lines.filter(line => line[0] !== '-').map(line => line.slice(1))
    const before = hunk.lines.filter(line => line[0] !== '+').map(line => line.slice(1))
    const start = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1
    if (after.some((line, offset) => lines[start + offset] !== line)) return undefined
    lines.splice(start, after.length, ...before)
  }
  return lines.join('\n')
}
