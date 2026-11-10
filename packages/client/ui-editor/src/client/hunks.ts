/** Line-hunk arithmetic for reviewing an Agent edit: pure text in, text out. */

/** One changed region, in Monaco's `ILineChange` convention (1-based, inclusive; an end of 0 means an empty side). */
export interface Hunk {
  /** First baseline line of the region, or the line before an insertion. */
  readonly originalStart: number
  /** Last baseline line of the region; 0 when the region only inserts. */
  readonly originalEnd: number
  /** First disk line of the region, or the line before a deletion. */
  readonly modifiedStart: number
  /** Last disk line of the region; 0 when the region only deletes. */
  readonly modifiedEnd: number
}

/**
 * Replace one side of a hunk inside `target` with lines taken from `source`.
 * @param target - text being edited.
 * @param targetStart - hunk start on the target side.
 * @param targetEnd - hunk end on the target side (0 for an empty side).
 * @param source - text supplying the replacement.
 * @param sourceStart - hunk start on the source side.
 * @param sourceEnd - hunk end on the source side (0 for an empty side).
 * @returns the edited text.
 */
function replaceRegion(
  target: string, targetStart: number, targetEnd: number,
  source: string, sourceStart: number, sourceEnd: number,
): string {
  const lines = target.split('\n')
  const from = targetEnd === 0 ? targetStart : targetStart - 1
  const count = targetEnd === 0 ? 0 : targetEnd - targetStart + 1
  const replacement = sourceEnd === 0 ? [] : source.split('\n').slice(sourceStart - 1, sourceEnd)
  lines.splice(from, count, ...replacement)
  return lines.join('\n')
}

/**
 * Accept one hunk: the baseline takes the disk lines.
 * @param baseline - the last accepted text.
 * @param disk - the text currently on disk.
 * @param hunk - the region to accept.
 * @returns the new baseline.
 */
export function acceptHunk(baseline: string, disk: string, hunk: Hunk): string {
  return replaceRegion(baseline, hunk.originalStart, hunk.originalEnd, disk, hunk.modifiedStart, hunk.modifiedEnd)
}

/**
 * Reject one hunk: the disk text takes the baseline lines back.
 * @param baseline - the last accepted text.
 * @param disk - the text currently on disk.
 * @param hunk - the region to reject.
 * @returns the text to write to disk.
 */
export function rejectHunk(baseline: string, disk: string, hunk: Hunk): string {
  return replaceRegion(disk, hunk.modifiedStart, hunk.modifiedEnd, baseline, hunk.originalStart, hunk.originalEnd)
}

const MAX_CELLS = 4_000_000

/** Unchanged lines tolerated inside one reviewable block; longer runs split it. */
const MERGE_CONTEXT = 6

/** One side of a changed region as a 0-based start plus a line count (0 for an insertion). */
interface Span {
  readonly start: number
  readonly count: number
}

/**
 * Convert one hunk side to a 0-based span.
 * @param hunk - the changed region.
 * @param side - which text side to read.
 * @returns the span of touched lines.
 */
function spanOf(hunk: Hunk, side: 'original' | 'modified'): Span {
  const start = side === 'original' ? hunk.originalStart : hunk.modifiedStart
  const end = side === 'original' ? hunk.originalEnd : hunk.modifiedEnd
  return end === 0 ? { start, count: 0 } : { start: start - 1, count: end - start + 1 }
}

/**
 * Convert two spans back to the hunk convention.
 * @param original - baseline span.
 * @param modified - disk span.
 * @returns the changed region.
 */
function hunkOf(original: Span, modified: Span): Hunk {
  return {
    originalStart: original.count === 0 ? original.start : original.start + 1,
    originalEnd: original.count === 0 ? 0 : original.start + original.count,
    modifiedStart: modified.count === 0 ? modified.start : modified.start + 1,
    modifiedEnd: modified.count === 0 ? 0 : modified.start + modified.count,
  }
}

/**
 * Fold regions separated by a short unchanged run into one reviewable block, so a
 * block that spans a few shared lines (typically blank lines) is reviewed once.
 * @param hunks - raw line-diff regions in file order.
 * @returns the merged blocks.
 */
function mergeContext(hunks: readonly Hunk[]): Hunk[] {
  const blocks: Array<{ original: Span; modified: Span }> = []
  for (const hunk of hunks) {
    const original = spanOf(hunk, 'original')
    const modified = spanOf(hunk, 'modified')
    const last = blocks[blocks.length - 1]
    if (last !== undefined && original.start - (last.original.start + last.original.count) <= MERGE_CONTEXT) {
      blocks[blocks.length - 1] = {
        original: { start: last.original.start, count: Math.max(last.original.count, original.start + original.count - last.original.start) },
        modified: { start: last.modified.start, count: Math.max(last.modified.count, modified.start + modified.count - last.modified.start) },
      }
      continue
    }
    blocks.push({ original, modified })
  }
  return blocks.map(({ original, modified }) => hunkOf(original, modified))
}

/**
 * Line diff between the accepted text and the disk text.
 * @param baseline - last accepted text.
 * @param disk - text currently on disk.
 * @returns changed blocks in file order; one block spanning both sides when the files are too large to align.
 */
export function computeHunks(baseline: string, disk: string): Hunk[] {
  if (baseline === disk) return []
  const a = baseline.split('\n')
  const b = disk.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const n = a.length - head - tail
  const m = b.length - head - tail
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS) {
    return [{
      originalStart: n === 0 ? head : head + 1, originalEnd: n === 0 ? 0 : head + n,
      modifiedStart: m === 0 ? head : head + 1, modifiedEnd: m === 0 ? 0 : head + m,
    }]
  }
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[head + i] === b[head + j]
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[head + i] === b[head + j]) { i++; j++; continue }
    const startI = i
    const startJ = j
    while ((i < n || j < m) && !(i < n && j < m && a[head + i] === b[head + j])) {
      if (j >= m || (i < n && table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) i++
      else j++
    }
    hunks.push({
      originalStart: i === startI ? head + startI : head + startI + 1,
      originalEnd: i === startI ? 0 : head + i,
      modifiedStart: j === startJ ? head + startJ : head + startJ + 1,
      modifiedEnd: j === startJ ? 0 : head + j,
    })
  }
  return mergeContext(hunks)
}
