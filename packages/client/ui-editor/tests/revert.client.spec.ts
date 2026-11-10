import { describe, expect, it } from 'vitest'
import { revertHunks } from '../src/client/revert.ts'

describe('revertHunks', () => {
  it('restores replaced, added and deleted lines across several hunks', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\n'
    const after = 'a\nB\nc\nd\ne\nf\nx\ng\n'
    const hunks = [
      { newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] },
      { newStart: 6, newLines: 3, lines: [' f', '+x', ' g'] },
    ]
    expect(revertHunks(after, hunks)).toBe(before)
  })

  it('restores a pure deletion', () => {
    const hunks = [{ newStart: 0, newLines: 0, lines: ['-a'] }]
    expect(revertHunks('b\n', hunks)).toBe('a\nb\n')
  })

  it('refuses when the file changed after the turn', () => {
    const hunks = [{ newStart: 2, newLines: 1, lines: ['-b', '+B'] }]
    expect(revertHunks('a\nedited\nc\n', hunks)).toBeUndefined()
  })
})
