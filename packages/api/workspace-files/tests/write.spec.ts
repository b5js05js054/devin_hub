/** The `write` endpoint: version-guarded replacement of an existing workspace file. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-files-write-')
})

afterEach(async () => {
  await harness.dispose()
})

describe('workspaceFiles.write', () => {
  it('replaces the text under the version a read reported and returns the new version', async () => {
    const path = join(harness.workspace, 'notes.txt')
    await writeFile(path, 'one\n', 'utf8')
    const endpoint = harness.endpoint()
    const page = await endpoint.read(harness.scope, 'notes.txt', {}, signal())
    const written = await endpoint.write(harness.scope, 'notes.txt', 'one\ntwo\n', page.version, signal())
    expect(await readFile(path, 'utf8')).toBe('one\ntwo\n')
    expect(written.version).not.toBe(page.version)
    expect(written.bytes).toBe(8)
    expect((await endpoint.stat(harness.scope, 'notes.txt', signal())).version).toBe(written.version)
  })

  it('refuses a stale version and leaves the file untouched', async () => {
    const path = join(harness.workspace, 'notes.txt')
    await writeFile(path, 'one\n', 'utf8')
    const endpoint = harness.endpoint()
    const page = await endpoint.read(harness.scope, 'notes.txt', {}, signal())
    await writeFile(path, 'changed elsewhere\n', 'utf8')
    expect(await failureOf(endpoint.write(harness.scope, 'notes.txt', 'mine\n', page.version, signal()))).toMatchObject({
      code: 'workspace-file/stale-version',
    })
    expect(await readFile(path, 'utf8')).toBe('changed elsewhere\n')
  })

  it('refuses files outside the workspace, missing files, and directories', async () => {
    await writeFile(join(harness.outside, 'secret.txt'), 'no', 'utf8')
    await mkdir(join(harness.workspace, 'src'))
    const endpoint = harness.endpoint()
    const version = (await endpoint.stat(harness.scope, join(harness.outside, 'secret.txt'), signal())).version
    expect((await failureOf(endpoint.write(harness.scope, join(harness.outside, 'secret.txt'), 'x', version, signal()))).code)
      .toBe('workspace-file/outside-workspace')
    expect((await failureOf(endpoint.write(harness.scope, 'nope.txt', 'x', version, signal()))).code).toBe('workspace-file/not-found')
    expect((await failureOf(endpoint.write(harness.scope, 'src', 'x', version, signal()))).details).toMatchObject({ kind: 'directory' })
    expect(await readFile(join(harness.outside, 'secret.txt'), 'utf8')).toBe('no')
  })

  it('refuses a symlink and leaves its target untouched', async (context) => {
    await writeFile(join(harness.outside, 'secret.txt'), 'no', 'utf8')
    try {
      await symlink(join(harness.outside, 'secret.txt'), join(harness.workspace, 'link.txt'))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EPERM') return context.skip()
      throw cause
    }
    const endpoint = harness.endpoint()
    const version = (await endpoint.stat(harness.scope, join(harness.outside, 'secret.txt'), signal())).version
    expect((await failureOf(endpoint.write(harness.scope, 'link.txt', 'x', version, signal()))).details).toMatchObject({ kind: 'symlink' })
    expect(await readFile(join(harness.outside, 'secret.txt'), 'utf8')).toBe('no')
  })

  it('refuses NUL content and content over the full-file cap', async () => {
    await writeFile(join(harness.workspace, 'notes.txt'), 'one\n', 'utf8')
    const endpoint = harness.endpoint({ maxFileBytes: 8 })
    const version = (await endpoint.stat(harness.scope, 'notes.txt', signal())).version
    expect((await failureOf(endpoint.write(harness.scope, 'notes.txt', `a${String.fromCharCode(0)}b`, version, signal()))).code)
      .toBe('workspace-file/not-text')
    expect((await failureOf(endpoint.write(harness.scope, 'notes.txt', '123456789', version, signal()))).code)
      .toBe('workspace-file/too-large')
    expect(await readFile(join(harness.workspace, 'notes.txt'), 'utf8')).toBe('one\n')
  })
})
