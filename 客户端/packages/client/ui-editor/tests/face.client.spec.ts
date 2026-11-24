import { describe, expect, it, vi } from 'vitest'
import { ideFace, readText } from '../src/client/face.ts'
import { createIdeStore } from '../src/client/store.ts'

type Page = { text: string; lines: number; eof: boolean; version: string; bytes?: number }
type WatchItem = { value: { kind: 'ready' | 'change' }; accept(): void }
type WatchStream = { [Symbol.asyncIterator](): AsyncIterator<WatchItem>; dispose(): Promise<void> }

function emptyWatch(): { stream: WatchStream; push: (kind: WatchItem['value']['kind']) => void } {
  const watch = controlledWatch()
  return { stream: watch.stream, push: watch.push }
}

function controlledWatch() {
  const pending: WatchItem[] = []
  const waiters: Array<(result: IteratorResult<WatchItem>) => void> = []
  let ended = false
  const iterator: AsyncIterator<WatchItem> = {
    next: () => {
      const item = pending.shift()
      if (item !== undefined) return Promise.resolve({ done: false as const, value: item })
      if (ended) return Promise.resolve({ done: true as const, value: undefined })
      return new Promise((resolve) => { waiters.push(resolve) })
    },
    return: async () => {
      ended = true
      for (const resolve of waiters.splice(0)) resolve({ done: true, value: undefined })
      return { done: true, value: undefined }
    },
  }
  const stream: WatchStream = {
    [Symbol.asyncIterator]: () => iterator,
    dispose: async () => { await iterator.return?.() },
  }
  return {
    stream,
    push: (kind: WatchItem['value']['kind']) => {
      const item: WatchItem = { value: { kind }, accept: () => {} }
      const resolve = waiters.shift()
      if (resolve !== undefined) resolve({ done: false, value: item })
      else pending.push(item)
    },
  }
}

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

const PATH = '/w/a.ts'

/** A Host holding one file whose text and version the test changes directly; `undefined` makes reads fail. */
function hostOf(initial: { text: string; version: string } | undefined, watch = emptyWatch()) {
  const host = {
    file: initial, reads: 0, readError: undefined as Error | undefined, unreachable: false,
    writes: [] as { body: string; version: string }[],
  }
  let next = 1
  const remote = {
    $stream: () => watch.stream,
    workspaceFiles: {
      read: async () => {
        host.reads++
        if (host.readError !== undefined) throw host.readError
        return host.file === undefined
          ? { ok: false as const, error: { code: 'workspace-file/not-found', message: 'File no longer exists' } }
          : { ok: true as const, value: { text: host.file.text, lines: host.file.text.split('\n').length, eof: true, version: host.file.version, bytes: new TextEncoder().encode(host.file.text).length + 1 } }
      },
      write: async (_session: unknown, _path: string, body: string, version: string) => {
        if (host.unreachable) throw new Error('unreachable')
        host.writes.push({ body, version })
        if (host.file?.version !== version) return { ok: false as const, error: { code: 'workspace-file/stale-version' } }
        host.file = { text: body.replace(/\n$/, ''), version: `w${next++}` }
        return { ok: true as const, value: { absolutePath: PATH, version: host.file.version, bytes: body.length } }
      },
    },
  }
  const handle = createIdeStore().create()
  const face = ideFace(remote as never, 's' as never, handle.actions)
  const file = () => handle.store.getSnapshot().files[PATH]
  return { host, handle, face, file, watch }
}

describe('ideFace', () => {
  it('refuses a save made against text the disk no longer holds, and overwrites only on request', async () => {
    const { host, handle, face, file } = hostOf({ text: 'one', version: 'v1' })
    face.openFile(PATH, 'a.ts')
    await vi.waitFor(() => { expect(file()?.status).toBe('ready') })
    handle.actions.edited(PATH, 'mine')
    host.file = { text: 'theirs', version: 'v2' }
    face.reload(PATH)
    await vi.waitFor(() => { expect(file()).toMatchObject({ error: 'stale', version: 'v1', diskVersion: 'v2', draft: 'mine' }) })

    face.write(PATH, 'mine', file()!.version, file()!.disk)
    await vi.waitFor(() => { expect(host.writes).toHaveLength(1) })
    await vi.waitFor(() => { expect(file()).toMatchObject({ saving: false, error: 'stale' }) })
    expect(host.file).toEqual({ text: 'theirs', version: 'v2' })

    face.write(PATH, 'mine', file()!.diskVersion, file()!.disk)
    await vi.waitFor(() => { expect(file()).toMatchObject({ saving: false, disk: 'mine', draft: 'mine', baseline: 'mine', version: 'w1', diskVersion: 'w1' }) })
    expect(file()?.error).toBeUndefined()
    expect(host.writes[1]).toEqual({ body: 'mine\n', version: 'v2' })
  })

  it('keeps an open file and its unsaved edits when a reread fails, and recovers on reload', async () => {
    const { host, handle, face, file } = hostOf({ text: 'one', version: 'v1' })
    face.openFile(PATH, 'a.ts')
    await vi.waitFor(() => { expect(file()?.status).toBe('ready') })
    handle.actions.edited(PATH, 'mine')
    host.file = undefined
    face.reload(PATH)
    await vi.waitFor(() => {
      expect(file()).toMatchObject({
        status: 'ready', error: 'read', draft: 'mine',
        readFailure: { code: 'workspace-file/not-found', message: 'File no longer exists' },
      })
    })
    host.file = { text: 'one', version: 'v1' }
    face.reload(PATH)
    await vi.waitFor(() => { expect(file()?.error).toBeUndefined() })
    expect(file()).toMatchObject({ status: 'ready', draft: 'mine', version: 'v1' })
    expect(file()?.readFailure).toBeUndefined()
  })

  it('reads before the file watch is ready and catches up when it is', async () => {
    const watch = controlledWatch()
    const { host, face, file } = hostOf({ text: 'one', version: 'v1' }, watch)
    face.openFile(PATH, 'a.ts')
    await vi.waitFor(() => { expect(file()).toMatchObject({ status: 'ready', draft: 'one', version: 'v1' }) })
    expect(host.reads).toBe(1)

    host.file = { text: 'two', version: 'v2' }
    watch.push('ready')
    await vi.waitFor(() => { expect(file()).toMatchObject({ status: 'ready', disk: 'two', diskVersion: 'v2' }) })
    expect(host.reads).toBe(2)
    face.closeFile(PATH)
  })

  it('recovers a failed first read when the file watch becomes ready', async () => {
    const watch = controlledWatch()
    const { host, face, file } = hostOf(undefined, watch)
    face.openFile(PATH, 'a.ts')
    await vi.waitFor(() => { expect(file()).toMatchObject({ status: 'failed', error: 'read' }) })
    expect(host.reads).toBe(1)

    host.file = { text: 'one', version: 'v1' }
    watch.push('ready')
    await vi.waitFor(() => { expect(file()).toMatchObject({ status: 'ready', draft: 'one', version: 'v1' }) })
    expect(host.reads).toBe(2)
    face.closeFile(PATH)
  })

  it('rereads on a file change after the watch is ready', async () => {
    const watch = controlledWatch()
    const { host, face, file } = hostOf({ text: 'one', version: 'v1' }, watch)
    face.openFile(PATH, 'a.ts')
    await vi.waitFor(() => { expect(file()).toMatchObject({ status: 'ready', disk: 'one', diskVersion: 'v1' }) })
    expect(host.reads).toBe(1)

    watch.push('ready')
    await vi.waitFor(() => { expect(host.reads).toBe(2) })
    host.file = { text: 'two', version: 'v2' }
    watch.push('change')
    await vi.waitFor(() => { expect(file()).toMatchObject({ status: 'ready', disk: 'two', diskVersion: 'v2' }) })
    expect(host.reads).toBe(3)
    face.closeFile(PATH)
  })

  it('rereads after a watcher reconnects and preserves an unsaved draft', async () => {
    const watch = controlledWatch()
    const { host, handle, face, file } = hostOf({ text: 'one', version: 'v1' }, watch)
    face.openFile(PATH, 'a.ts')
    await vi.waitFor(() => { expect(file()).toMatchObject({ status: 'ready', disk: 'one', diskVersion: 'v1' }) })
    expect(host.reads).toBe(1)

    watch.push('ready')
    await vi.waitFor(() => { expect(host.reads).toBe(2) })
    handle.actions.edited(PATH, 'mine')
    host.file = { text: 'two', version: 'v2' }
    watch.push('ready')
    await vi.waitFor(() => { expect(file()).toMatchObject({ status: 'ready', error: 'stale', disk: 'two', diskVersion: 'v2', draft: 'mine' }) })
    expect(host.reads).toBe(3)
    face.closeFile(PATH)
  })

  it('opens a file whose first read failed once a reload can read it', async () => {
    const { host, face, file } = hostOf(undefined)
    face.openFile(PATH, 'a.ts')
    await vi.waitFor(() => {
      expect(file()).toMatchObject({
        status: 'failed', error: 'read', readFailure: { code: 'workspace-file/not-found', message: 'File no longer exists' },
      })
    })
    host.file = { text: 'one', version: 'v1' }
    face.reload(PATH)
    await vi.waitFor(() => { expect(file()).toMatchObject({ status: 'ready', name: 'a.ts', baseline: 'one', draft: 'one', version: 'v1' }) })
  })

  it('preserves an unexpected read exception and clears it after a successful retry', async () => {
    const { host, face, file } = hostOf({ text: 'one', version: 'v1' })
    const readError = new Error('Connection response could not be decoded')
    host.readError = readError
    face.openFile(PATH, 'a.ts')
    await vi.waitFor(() => {
      expect(file()).toMatchObject({ status: 'failed', readFailure: { code: 'client/read-failed', message: readError.message } })
    })
    expect(Object.getPrototypeOf(file()!.readFailure)).toBe(Object.prototype)
    host.readError = undefined
    face.reload(PATH)
    await vi.waitFor(() => { expect(file()?.status).toBe('ready') })
    expect(file()?.readFailure).toBeUndefined()
    face.closeFile(PATH)
  })

  it('reports a save the Host could not be reached for and keeps the draft unsaved', async () => {
    const { host, handle, face, file } = hostOf({ text: 'one', version: 'v1' })
    face.openFile(PATH, 'a.ts')
    await vi.waitFor(() => { expect(file()?.status).toBe('ready') })
    handle.actions.edited(PATH, 'mine')
    host.unreachable = true
    face.write(PATH, 'mine', 'v1', 'one')
    await vi.waitFor(() => { expect(file()).toMatchObject({ saving: false, error: 'save', draft: 'mine', disk: 'one' }) })
  })

  it('writes a rejected block back without taking it into the baseline', async () => {
    const { host, face, file } = hostOf({ text: 'one', version: 'v1' })
    face.openFile(PATH, 'a.ts')
    await vi.waitFor(() => { expect(file()?.status).toBe('ready') })
    host.file = { text: 'agent', version: 'v2' }
    face.reload(PATH)
    await vi.waitFor(() => { expect(file()).toMatchObject({ disk: 'agent', draft: 'agent', baseline: 'one' }) })
    face.write(PATH, 'one', file()!.diskVersion)
    await vi.waitFor(() => { expect(file()).toMatchObject({ saving: false, disk: 'one', draft: 'one', baseline: 'one' }) })
  })
})
