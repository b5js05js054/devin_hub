import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness
let workspace: string

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-files-search-')
  workspace = harness.workspace
  await mkdir(join(workspace, 'src'), { recursive: true })
  await mkdir(join(workspace, 'node_modules', 'dependency'), { recursive: true })
  await writeFile(join(workspace, 'src', 'alpha.ts'), 'const answer = 42\nAlpha again', 'utf8')
  await writeFile(join(workspace, 'src', 'beta.txt'), 'nothing here', 'utf8')
  await writeFile(join(workspace, 'node_modules', 'dependency', 'alpha.ts'), 'answer', 'utf8')
})
afterEach(async () => { await harness.dispose() })

describe('workspaceFiles.search', () => {
  it('finds basenames throughout the workspace, excluding dependency directories', async () => {
    const result = await harness.endpoint().search(harness.scope, { kind: 'files', query: 'ALPHA' }, signal())
    expect(result.truncated).toBe(false)
    expect(result.matches.map(match => match.path)).toEqual(['src/alpha.ts'])
    expect(result.matches[0]?.absolutePath).toBe(join(workspace, 'src', 'alpha.ts'))
  })

  it('returns literal line and column positions, with case sensitivity by default', async () => {
    const service = harness.endpoint()
    const result = await service.search(harness.scope, { kind: 'content', query: 'answer' }, signal())
    expect(result.matches).toEqual([{ absolutePath: join(workspace, 'src', 'alpha.ts'), path: 'src/alpha.ts', line: 1, column: 7, text: 'const answer = 42' }])
    expect((await service.search(harness.scope, { kind: 'content', query: 'alpha', ignoreCase: true }, signal())).matches).toHaveLength(1)
  })

  it('skips oversized files, binary content and directory links outside the workspace', async () => {
    await writeFile(join(workspace, 'src', 'large.txt'), 'answer'.repeat(100), 'utf8')
    await writeFile(join(workspace, 'src', 'binary.dat'), 'answer\0', 'utf8')
    await writeFile(join(harness.outside, 'outside.ts'), 'answer', 'utf8')
    await symlink(harness.outside, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const service = harness.endpoint({ searchMaxFileBytes: 128 })
    expect((await service.search(harness.scope, { kind: 'content', query: 'answer' }, signal())).matches.map(match => match.path)).toEqual(['src/alpha.ts'])
    expect((await service.search(harness.scope, { kind: 'files', query: 'outside' }, signal())).matches).toEqual([])
  })

  it('refuses a file symlink even when its target is inside the workspace', async (context) => {
    try {
      await symlink(join(workspace, 'src', 'alpha.ts'), join(workspace, 'alias.ts'), 'file')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EPERM') return context.skip()
      throw cause
    }
    const result = await harness.endpoint().search(harness.scope, { kind: 'files', query: 'alias' }, signal())
    expect(result.matches).toEqual([])
  })

  it('marks an unreadable directory as partial instead of reporting a complete search', async () => {
    await mkdir(join(workspace, 'blocked'))
    const listDir = harness.ctx.fs.listDir.bind(harness.ctx.fs)
    harness.ctx.fs.listDir = async (target, signal) => {
      if (harness.ctx.fs.processPath(target) === join(workspace, 'blocked')) throw new Error('unreadable')
      return await listDir(target, signal)
    }
    const result = await harness.endpoint().search(harness.scope, { kind: 'files', query: 'alpha' }, signal())
    expect(result).toEqual({ matches: [{ absolutePath: join(workspace, 'src', 'alpha.ts'), path: 'src/alpha.ts' }], truncated: true })
  })

  it('reports the scanned-entry bound', async () => {
    const result = await harness.endpoint({ searchMaxEntries: 1 }).search(harness.scope, { kind: 'files', query: 'alpha' }, signal())
    expect(result.truncated).toBe(true)
  })

  it('propagates cancellation instead of reporting an empty result', async () => {
    const controller = new AbortController()
    vi.spyOn(harness.ctx.fs, 'listDir').mockImplementationOnce(async () => {
      controller.abort()
      throw new Error('cancelled')
    })
    await expect(harness.endpoint().search(harness.scope, { kind: 'files', query: 'alpha' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('caps results and rejects blank or unbounded queries', async () => {
    const service = harness.endpoint()
    const result = await service.search(harness.scope, { kind: 'content', query: 'a', limit: 1 }, signal())
    expect(result.matches).toHaveLength(1)
    expect(result.truncated).toBe(true)
    expect((await failureOf(service.search(harness.scope, { kind: 'files', query: '  ' }, signal()))).code).toBe('gateway/bad-request')
    expect((await failureOf(service.search(harness.scope, { kind: 'files', query: 'a', limit: 201 }, signal()))).code).toBe('gateway/bad-request')
  })
})
