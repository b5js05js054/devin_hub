/** The `createEntry`, `rename` and `trash` endpoints: workspace-confined entry mutations. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-files-mutate-')
})

afterEach(async () => {
  await harness.dispose()
})

describe('workspaceFiles.createEntry', () => {
  it('creates an empty file and a directory inside the workspace', async () => {
    const endpoint = harness.endpoint()
    await endpoint.createEntry(harness.scope, 'new.txt', 'file', signal())
    await endpoint.createEntry(harness.scope, 'dir', 'directory', signal())
    expect(await readFile(join(harness.workspace, 'new.txt'), 'utf8')).toBe('')
    expect((await stat(join(harness.workspace, 'dir'))).isDirectory()).toBe(true)
  })

  it('refuses an existing file without overwriting it', async () => {
    await writeFile(join(harness.workspace, 'a.txt'), 'keep', 'utf8')
    await expect(harness.endpoint().createEntry(harness.scope, 'a.txt', 'file', signal())).rejects.toBeDefined()
    expect(await readFile(join(harness.workspace, 'a.txt'), 'utf8')).toBe('keep')
  })

  it('refuses paths outside the workspace and creates nothing there', async () => {
    const endpoint = harness.endpoint()
    const target = join(harness.outside, 'x.txt')
    expect((await failureOf(endpoint.createEntry(harness.scope, target, 'file', signal()))).code).toBe('workspace-file/outside-workspace')
    expect((await failureOf(endpoint.createEntry(harness.scope, '../escape', 'directory', signal()))).code).toBe('workspace-file/outside-workspace')
    expect(existsSync(target)).toBe(false)
  })
})

describe('workspaceFiles.rename', () => {
  it('moves a file and never replaces an existing destination', async () => {
    await writeFile(join(harness.workspace, 'a.txt'), 'a', 'utf8')
    await writeFile(join(harness.workspace, 'b.txt'), 'b', 'utf8')
    const endpoint = harness.endpoint()
    await expect(endpoint.rename(harness.scope, 'a.txt', 'b.txt', signal())).rejects.toBeDefined()
    expect(await readFile(join(harness.workspace, 'b.txt'), 'utf8')).toBe('b')
    await endpoint.rename(harness.scope, 'a.txt', 'c.txt', signal())
    expect(await readFile(join(harness.workspace, 'c.txt'), 'utf8')).toBe('a')
    expect(existsSync(join(harness.workspace, 'a.txt'))).toBe(false)
  })

  it('refuses a destination outside the workspace, a missing source, and the workspace root', async () => {
    await writeFile(join(harness.workspace, 'a.txt'), 'a', 'utf8')
    const endpoint = harness.endpoint()
    expect((await failureOf(endpoint.rename(harness.scope, 'a.txt', join(harness.outside, 'a.txt'), signal()))).code)
      .toBe('workspace-file/outside-workspace')
    expect((await failureOf(endpoint.rename(harness.scope, 'nope.txt', 'x.txt', signal()))).code).toBe('workspace-file/not-found')
    expect((await failureOf(endpoint.rename(harness.scope, harness.workspace, 'moved', signal()))).code).toBe('workspace-file/outside-workspace')
    expect(existsSync(join(harness.workspace, 'a.txt'))).toBe(true)
    expect(existsSync(join(harness.outside, 'a.txt'))).toBe(false)
  })
})

describe('workspaceFiles.trash', () => {
  it('refuses entries outside the workspace, missing entries, and the workspace root', async () => {
    await writeFile(join(harness.outside, 'secret.txt'), 'no', 'utf8')
    await mkdir(join(harness.workspace, 'src'))
    const endpoint = harness.endpoint()
    expect((await failureOf(endpoint.trash(harness.scope, join(harness.outside, 'secret.txt'), signal()))).code)
      .toBe('workspace-file/outside-workspace')
    expect((await failureOf(endpoint.trash(harness.scope, 'nope.txt', signal()))).code).toBe('workspace-file/not-found')
    expect((await failureOf(endpoint.trash(harness.scope, harness.workspace, signal()))).code).toBe('workspace-file/outside-workspace')
    expect(existsSync(join(harness.outside, 'secret.txt'))).toBe(true)
    expect(existsSync(harness.workspace)).toBe(true)
  })
})
