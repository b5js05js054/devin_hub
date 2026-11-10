import { describe, expect, it } from 'vitest'
import { rejectTurn } from '../src/client/turn-review.ts'

const hunk = { newStart: 1, newLines: 1, lines: ['-old', '+new'] }
const diff = { kind: 'text', before: true, after: true, hunks: [hunk] }

function remoteOf(failWriteOf?: string) {
  const writes: string[] = []
  const read = async () => ({ ok: true as const, value: { text: 'new', lines: 1, eof: true, version: 'v1', bytes: 4 } })
  const write = async (_: unknown, path: string) => {
    if (path === failWriteOf) return { ok: false as const }
    writes.push(path)
    return { ok: true as const }
  }
  return { remote: { workspaceFiles: { read, write } } as never, writes }
}

const files = [{ path: '/w/a.ts', display: 'a.ts' }, { path: '/w/b.ts', display: 'b.ts' }]

describe('rejectTurn', () => {
  it('restores every file and reports their texts', async () => {
    const { remote, writes } = remoteOf()
    const result = await rejectTurn(remote, 's' as never, undefined, files, async () => diff)
    expect(writes).toEqual(['/w/a.ts', '/w/b.ts'])
    expect(result).toEqual({ restored: [{ path: '/w/a.ts', text: 'old' }, { path: '/w/b.ts', text: 'old' }] })
  })

  it('writes nothing when a file cannot be planned', async () => {
    const { remote, writes } = remoteOf()
    const result = await rejectTurn(remote, 's' as never, undefined, files, async index => (index === 1 ? undefined : diff))
    expect(writes).toEqual([])
    expect(result).toEqual({ failed: 'b.ts', written: [] })
  })

  it('reports the files already written when a later write fails', async () => {
    const { remote, writes } = remoteOf('/w/b.ts')
    const result = await rejectTurn(remote, 's' as never, undefined, files, async () => diff)
    expect(writes).toEqual(['/w/a.ts'])
    expect(result).toEqual({ failed: 'b.ts', written: [{ path: '/w/a.ts', text: 'old' }] })
  })
})
