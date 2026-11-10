import { describe, expect, it } from 'vitest'
import { readText } from '../src/client/face.ts'

type Page = { text: string; lines: number; eof: boolean; version: string; bytes?: number }

function remoteOf(pages: readonly Page[]) {
  let index = 0
  const read = async () => ({ ok: true as const, value: pages[Math.min(index++, pages.length - 1)]! })
  return { workspaceFiles: { read } } as never
}

describe('readText', () => {
  it('joins pages that share one version', async () => {
    const remote = remoteOf([
      { text: 'a\nb', lines: 2, eof: false, version: 'v1' },
      { text: 'c', lines: 1, eof: true, version: 'v1', bytes: 6 },
    ])
    const result = await readText(remote, 's' as never, '/w/a.ts')
    expect(result).toEqual({ ok: true, value: { text: 'a\nb\nc', version: 'v1', finalNewline: true } })
  })

  it('rereads from the start when the version changes between pages', async () => {
    const remote = remoteOf([
      { text: 'old1\nold2', lines: 2, eof: false, version: 'v1' },
      { text: 'new3', lines: 1, eof: true, version: 'v2' },
      { text: 'new1\nnew2', lines: 2, eof: false, version: 'v2' },
      { text: 'new3', lines: 1, eof: true, version: 'v2' },
    ])
    const result = await readText(remote, 's' as never, '/w/a.ts')
    expect(result).toMatchObject({ ok: true, value: { text: 'new1\nnew2\nnew3', version: 'v2' } })
  })

  it('fails instead of returning a mixed read when the file never settles', async () => {
    let n = 0
    const read = async () => ({ ok: true as const, value: { text: 'x', lines: 1, eof: false, version: `v${n++}` } })
    const result = await readText({ workspaceFiles: { read } } as never, 's' as never, '/w/a.ts')
    expect(result.ok).toBe(false)
  })
})
