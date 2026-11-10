/** The IDE's asynchronous half: directory listing, paged file reads, saves, and watch lifetimes. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceSearchRequest, WorkspaceSearchResult } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { createIdeStore } from './store.ts'

/** Store write set as the face and components receive it. */
export type IdeActions = BoundActions<ReturnType<typeof createIdeStore>>

/** Business face injected into the workspace component. */
export interface IdeInjected {
  /** List a directory and keep it fresh: later changes under it relist it. */
  readonly loadDir: (path: string) => void
  /** Find filenames or literal content across the workspace, including directories not expanded in the tree. */
  readonly search: (request: WorkspaceSearchRequest, signal: AbortSignal) => Promise<WorkspaceSearchResult>
  /** Stop every directory watch, as when the workspace root changes or the page unmounts. */
  readonly closeDirs: () => void
  /** Open a tab; read and watch the file when it is not already open. */
  readonly openFile: (path: string, name: string) => void
  readonly closeFile: (path: string) => void
  /** Create an empty file or a directory at `path`; false when the Host refused. */
  readonly createEntry: (path: string, kind: 'file' | 'directory') => Promise<boolean>
  /** Move an entry to `newPath`; open tabs under it are closed. False when refused. */
  readonly renameEntry: (path: string, newPath: string) => Promise<boolean>
  /** Move an entry to the Host recycle bin; open tabs under it are closed. False when refused. */
  readonly trashEntry: (path: string) => Promise<boolean>
  /** Write `text` to disk (the editor draft, or a rejected-hunk result). */
  readonly write: (path: string, text: string) => void
  /** Take the current disk text of each open file as its reviewed baseline. */
  readonly acceptPaths: (paths: readonly string[]) => void
  /** Make `text` the reviewed baseline of an open file, as after a restore. */
  readonly rebase: (path: string, text: string) => void
}

/**
 * Read a whole text file page by page.
 * @param remote - the Client Remote carrying `workspaceFiles`.
 * @param sessionId - Session owning the workspace.
 * @param path - absolute workspace path.
 * @returns the joined text, its version and whether it ends with a newline, or the failed read.
 */
export async function readText(remote: ClientRemote, sessionId: SessionId, path: string) {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const parts: string[] = []
    let offset = 1
    let version: string | undefined
    let changed = false
    while (!changed) {
      const page = await remote.workspaceFiles.read(sessionId, path, { offset, limit: PAGE_LINES }, new AbortController().signal)
      if (!page.ok) return page
      if (version !== undefined && page.value.version !== version) { changed = true; break }
      version = page.value.version
      if (page.value.lines > 0) parts.push(page.value.text)
      if (page.value.eof || page.value.lines === 0) {
        const text = parts.join('\n')
        const finalNewline = page.value.bytes !== undefined && page.value.bytes === new TextEncoder().encode(text).length + 1
        return { ok: true as const, value: { text, version: page.value.version, finalNewline } }
      }
      offset += page.value.lines
    }
  }
  return { ok: false as const }
}

const PAGE_LINES = 2000
const READ_ATTEMPTS = 3
const DIR_REFRESH_MS = 150

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
}

function imageMediaType(name: string): string | undefined {
  return IMAGE_TYPES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()]
}

interface Tracked {
  version: string
  finalNewline: boolean
  watch: AbortController
}

/**
 * Build the face bound to one Session.
 * @param remote - the Client Remote carrying `workspaceFiles`.
 * @param sessionId - Session owning the workspace.
 * @param actions - that Session's store write set.
 * @returns the injected face.
 */
export function ideFace(remote: ClientRemote, sessionId: SessionId, actions: IdeActions): IdeInjected {
  const listings = new Map<string, AbortController>()
  const tracked = new Map<string, Tracked>()
  const images = new Map<string, string>()

  const readAll = (path: string) => readText(remote, sessionId, path)
  const loadSeq = new Map<string, number>()
  const dirWatches = new Map<string, AbortController>()
  const dirTimers = new Map<string, ReturnType<typeof setTimeout>>()

  async function load(path: string, name: string, first: boolean): Promise<void> {
    const seq = (loadSeq.get(path) ?? 0) + 1
    loadSeq.set(path, seq)
    const result = await readAll(path)
    if (loadSeq.get(path) !== seq) return
    const entry = tracked.get(path)
    if (entry === undefined) return
    if (!result.ok) { actions.fileFailed(path); return }
    const { text, version, finalNewline } = result.value
    entry.version = version
    entry.finalNewline = finalNewline
    if (first) {
      actions.fileRead({ path, name, status: 'ready', baseline: text, disk: text, draft: text, version, finalNewline, saving: false })
    } else {
      actions.disk(path, text, version, finalNewline)
    }
  }

  async function loadImage(path: string, name: string, mediaType: string): Promise<void> {
    const result = await remote.workspaceFiles.readBytes(sessionId, path, {}, new AbortController().signal)
    if (!tracked.has(path)) return
    if (!result.ok) { actions.fileFailed(path); return }
    const url = URL.createObjectURL(new Blob([result.value.data as Uint8Array<ArrayBuffer>], { type: mediaType }))
    images.set(path, url)
    actions.fileRead({
      path, name, status: 'ready', baseline: '', disk: '', draft: '', version: result.value.version,
      finalNewline: false, saving: false, image: url,
    })
  }

  function follow(path: string, name: string, lifetime: AbortSignal): void {
    const stream = remote.$stream<{ kind: 'ready' | 'change' }>({
      name: `file ${path}`,
      open: signal => remote.workspaceFiles.changes(sessionId, path, signal),
      ended: () => new Error(`File watch ended: ${path}`),
    })
    const stop = (): void => { void stream.dispose() }
    lifetime.addEventListener('abort', stop, { once: true })
    void (async () => {
      try {
        for await (const item of stream) {
          if (lifetime.aborted) break
          if (item.value.kind === 'ready') item.accept()
          else void load(path, name, false)
        }
      } finally {
        lifetime.removeEventListener('abort', stop)
        await stream.dispose()
      }
    })()
  }

  function watchDir(path: string): void {
    if (dirWatches.has(path)) return
    const lifetime = new AbortController()
    dirWatches.set(path, lifetime)
    const stream = remote.$stream<{ kind: 'ready' | 'change' }>({
      name: `directory ${path}`,
      open: signal => remote.workspaceFiles.changes(sessionId, path, signal),
      ended: () => new Error(`Directory watch ended: ${path}`),
    })
    const stop = (): void => { void stream.dispose() }
    lifetime.signal.addEventListener('abort', stop, { once: true })
    void (async () => {
      try {
        for await (const item of stream) {
          if (lifetime.signal.aborted) break
          if (item.value.kind === 'ready') { item.accept(); continue }
          clearTimeout(dirTimers.get(path))
          dirTimers.set(path, setTimeout(() => { dirTimers.delete(path); if (!lifetime.signal.aborted) face.loadDir(path) }, DIR_REFRESH_MS))
        }
      } finally {
        lifetime.signal.removeEventListener('abort', stop)
        await stream.dispose()
        if (dirWatches.get(path) === lifetime) dirWatches.delete(path)
      }
    })()
  }

  const parentOf = (path: string): string => path.replace(/[/\\][^/\\]*$/, '')
  const closeUnder = (path: string): void => {
    for (const open of [...tracked.keys()]) {
      if (open === path || open.startsWith(`${path}/`) || open.startsWith(`${path}\\`)) {
        tracked.get(open)?.watch.abort()
        tracked.delete(open)
        actions.closed(open)
      }
    }
  }
  const mutate = async (touched: readonly string[], run: (signal: AbortSignal) => Promise<{ ok: boolean }>): Promise<boolean> => {
    try {
      const result = await run(new AbortController().signal)
      if (result.ok) for (const dir of new Set(touched.map(parentOf))) face.loadDir(dir)
      return result.ok
    } catch {
      // A Host that cannot be reached fails the gesture like one that refused it; the tree announces both.
      return false
    }
  }

  const face: IdeInjected = {
    search: async (request, signal) => {
      const result = await remote.workspaceFiles.search(sessionId, request, signal)
      if (!result.ok) throw result.error
      return result.value
    },
    createEntry: (path, kind) => mutate([path], signal => remote.workspaceFiles.createEntry(sessionId, path, kind, signal)),
    renameEntry: async (path, newPath) => {
      const ok = await mutate([path, newPath], signal => remote.workspaceFiles.rename(sessionId, path, newPath, signal))
      if (ok) closeUnder(path)
      return ok
    },
    trashEntry: async (path) => {
      const ok = await mutate([path], signal => remote.workspaceFiles.trash(sessionId, path, signal))
      if (ok) closeUnder(path)
      return ok
    },
    loadDir: (path) => {
      listings.get(path)?.abort()
      const controller = new AbortController()
      listings.set(path, controller)
      actions.loading(path)
      watchDir(path)
      void remote.workspaceFiles.list(sessionId, path, controller.signal).then((result) => {
        if (controller.signal.aborted) return
        if (result.ok) actions.loaded(path, result.value.entries, result.value.truncated)
        else actions.failed(path, result.error)
      })
    },
    closeDirs: () => {
      for (const watch of dirWatches.values()) watch.abort()
      dirWatches.clear()
      for (const timer of dirTimers.values()) clearTimeout(timer)
      dirTimers.clear()
    },
    openFile: (path, name) => {
      actions.opened(path, name)
      if (tracked.has(path)) return
      const watch = new AbortController()
      tracked.set(path, { version: '', finalNewline: false, watch })
      const mediaType = imageMediaType(name)
      if (mediaType !== undefined) { void loadImage(path, name, mediaType); return }
      void load(path, name, true)
      follow(path, name, watch.signal)
    },
    closeFile: (path) => {
      tracked.get(path)?.watch.abort()
      tracked.delete(path)
      const url = images.get(path)
      if (url !== undefined) URL.revokeObjectURL(url)
      images.delete(path)
      actions.closed(path)
    },
    acceptPaths: (paths) => {
      for (const path of paths) if (tracked.has(path)) actions.baselineFromDisk(path)
    },
    rebase: (path, text) => { if (tracked.has(path)) actions.baselineSet(path, text) },
    write: (path, text) => {
      const entry = tracked.get(path)
      if (entry === undefined) return
      actions.saving(path, true)
      const body = entry.finalNewline && text !== '' ? `${text}\n` : text
      void remote.workspaceFiles.write(sessionId, path, body, entry.version, new AbortController().signal).then(async (result) => {
        if (!result.ok) {
          actions.saving(path, false, (result.error.code as string) === 'workspace-file/stale-version' ? 'stale' : 'save')
          return
        }
        actions.saving(path, false)
        await load(path, path, false)
      })
    },
  }
  return face
}
