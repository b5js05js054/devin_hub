import { describe, expect, it } from 'vitest'
import { acceptHunk, computeHunks, rejectHunk } from '../src/client/hunks.ts'

const cases: Array<[string, string, string]> = [
  ['replace', 'a\nb\nc', 'a\nX\nc'],
  ['insert', 'a\nc', 'a\nb\nc'],
  ['delete', 'a\nb\nc', 'a\nc'],
  ['append', 'a', 'a\nb\nc'],
  ['two regions', 'a\nb\nc\nd\ne', 'a\nB\nc\nd\nE\nF'],
  ['to empty', 'a\nb', ''],
  ['blank-line rewrite', 'x = 1\n\n\ny = 2\n\n\nz = 3', 'x = 10\n\n\ny = 20\n\n\nz = 30'],
]

describe('hunks', () => {
  it('has none for equal text', () => { expect(computeHunks('a\nb', 'a\nb')).toEqual([]) })
  it.each(cases)('%s: accepting every hunk reproduces disk, rejecting reproduces baseline', (_name, base, disk) => {
    const hunks = computeHunks(base, disk)
    expect(hunks.length).toBeGreaterThan(0)
    let accepted = base
    for (const hunk of [...hunks].reverse()) accepted = acceptHunk(accepted, disk, hunk)
    expect(accepted).toBe(disk)
    let rejected = disk
    for (const hunk of [...hunks].reverse()) rejected = rejectHunk(base, rejected, hunk)
    expect(rejected).toBe(base)
  })
  it('folds changes separated by a short unchanged run into one block', () => {
    const base = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n')
    const disk = base.replace('line 3', 'LINE 3').replace('line 5', 'LINE 5')
    const hunks = computeHunks(base, disk)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]).toMatchObject({ originalStart: 3, originalEnd: 5 })
    expect(acceptHunk(base, disk, hunks[0]!)).toBe(disk)
  })
  it('keeps changes separated by a long unchanged run as separate blocks', () => {
    const base = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n')
    const disk = base.replace('line 3', 'LINE 3').replace('line 15', 'LINE 15')
    const hunks = computeHunks(base, disk)
    expect(hunks).toHaveLength(2)
    expect(acceptHunk(base, disk, hunks[0]!)).toBe(base.replace('line 3', 'LINE 3'))
  })
  it('keeps one block when the whole file is a rewrite', () => {
    const base = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj'
    const disk = 'k\nl\nm\nn\no\np\nq\nr\ns\nt'
    expect(computeHunks(base, disk)).toHaveLength(1)
  })
})
