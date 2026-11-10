/**
 * Per-Session IDE state: the file tree's levels and expansion, the open editor
 * tabs, and for every opened file the text last accepted (`baseline`), the text
 * last seen on disk (`disk`) and the unsaved draft. A file whose `disk` differs
 * from its `baseline` is an Agent edit awaiting review.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'

/** One directory's listing state. */
export type LevelState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly entries: readonly WorkspaceDirectoryEntry[]; readonly truncated: boolean }
  | { readonly kind: 'failed'; readonly failure: RemoteFailure }

/** One opened file. */
export interface OpenFile {
  readonly path: string
  readonly name: string
  readonly status: 'loading' | 'ready' | 'failed'
  /** Last accepted text; the left side of a review. */
  readonly baseline: string
  /** Text most recently read from disk; the right side of a review. */
  readonly disk: string
  /** Editor text; equals `disk` while nothing is unsaved. */
  readonly draft: string
  /** Opaque Host freshness token of `disk`, required by the next save. */
  readonly version: string
  /** Whether the file ended with a line terminator, restored on save. */
  readonly finalNewline: boolean
  readonly saving: boolean
  /** Blob URL of an image file; such a file is previewed, never edited or watched. */
  readonly image?: string
  readonly error?: 'save' | 'stale' | 'read' | undefined
}

/** Whole IDE state of one Session. */
export interface IdeState {
  root: string | undefined
  levels: Record<string, LevelState>
  expanded: string[]
  tabs: string[]
  active: string | undefined
  files: Record<string, OpenFile>
  filesCollapsed: boolean
  agentCollapsed: boolean
  filesWidth: number
  agentWidth: number
  terminalOpen: boolean
  terminalHeight: number
  /** Keys of the terminals opened in the bottom panel, in tab order. */
  terminals: string[]
  terminal: string | undefined
  /** Extra Agent conversations opened beside the Session's own; the Session's own is `agent === undefined`. */
  agents: string[]
  agent: string | undefined
  /** File-tree rows currently selected (files and folders), in selection order. */
  selected: string[]
  /** Row a Shift-click range extends from. */
  anchor: string | undefined
}

type Draft = IdeState

/** The IDE store's complete write set. */
type IdeActions = {
  rooted: (d: Draft, root: string) => void
  loading: (d: Draft, path: string) => void
  loaded: (d: Draft, path: string, entries: readonly WorkspaceDirectoryEntry[], truncated: boolean) => void
  failed: (d: Draft, path: string, failure: RemoteFailure) => void
  toggled: (d: Draft, path: string) => void
  expandedAt: (d: Draft, path: string) => void
  opened: (d: Draft, path: string, name: string) => void
  activated: (d: Draft, path: string) => void
  closed: (d: Draft, path: string) => void
  fileRead: (d: Draft, file: OpenFile) => void
  fileFailed: (d: Draft, path: string) => void
  disk: (d: Draft, path: string, disk: string, version: string, finalNewline: boolean) => void
  edited: (d: Draft, path: string, draft: string) => void
  baselineSet: (d: Draft, path: string, baseline: string) => void
  baselineFromDisk: (d: Draft, path: string) => void
  saving: (d: Draft, path: string, saving: boolean, error?: 'save' | 'stale') => void
  layout: (d: Draft, patch: Partial<Pick<IdeState, 'filesCollapsed' | 'agentCollapsed' | 'filesWidth' | 'agentWidth' | 'terminalOpen' | 'terminalHeight'>>) => void
  selection: (d: Draft, paths: string[], anchor: string | undefined) => void
  agentAdded: (d: Draft, id: string) => void
  agentActivated: (d: Draft, id: string | undefined) => void
  agentClosed: (d: Draft, id: string) => void
  terminalAdded: (d: Draft, key: string) => void
  terminalActivated: (d: Draft, key: string) => void
  terminalClosed: (d: Draft, key: string) => void
}

/** Narrow `files[path]` for writers that only run on an opened file. */
function fileOf(d: Draft, path: string): { -readonly [K in keyof OpenFile]: OpenFile[K] } | undefined {
  return d.files[path]
}

/** localStorage key for the persisted panel layout (collapse flags and widths). */
const LAYOUT_KEY = 'dsh.ide.layout'

type LayoutPrefs = Pick<IdeState, 'filesCollapsed' | 'agentCollapsed' | 'filesWidth' | 'agentWidth' | 'terminalHeight'>

const DEFAULT_LAYOUT: LayoutPrefs = { filesCollapsed: false, agentCollapsed: false, filesWidth: 260, agentWidth: 420, terminalHeight: 240 }

/** Read the saved layout; any missing, corrupt, or out-of-range field falls back to its default. */
function readLayout(): LayoutPrefs {
  if (typeof localStorage === 'undefined') return DEFAULT_LAYOUT
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    const stored: unknown = raw === null ? undefined : JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null) return DEFAULT_LAYOUT
    const record = stored as Record<string, unknown>
    const flag = (key: 'filesCollapsed' | 'agentCollapsed'): boolean => typeof record[key] === 'boolean' ? record[key] : DEFAULT_LAYOUT[key]
    const size = (key: 'filesWidth' | 'agentWidth' | 'terminalHeight'): number => {
      const value = record[key]
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_LAYOUT[key]
    }
    return { filesCollapsed: flag('filesCollapsed'), agentCollapsed: flag('agentCollapsed'), filesWidth: size('filesWidth'), agentWidth: size('agentWidth'), terminalHeight: size('terminalHeight') }
  } catch {
    return DEFAULT_LAYOUT
  }
}

/** Save the layout preferences; storage failures (quota, privacy mode) are ignored. */
function writeLayout(d: LayoutPrefs): void {
  if (typeof localStorage === 'undefined') return
  try {
    const { filesCollapsed, agentCollapsed, filesWidth, agentWidth, terminalHeight } = d
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ filesCollapsed, agentCollapsed, filesWidth, agentWidth, terminalHeight }))
  } catch {
    // Persistence is best-effort; the in-memory layout stays authoritative.
  }
}

/**
 * Declare the IDE store; registered as an exclusive factory so every Session gets its own instance.
 * @returns the store handle.
 */
export function createIdeStore(): EngineStoreHandle<IdeState, IdeActions> {
  return defineStore({
    init: (): IdeState => ({
      root: undefined, levels: {}, expanded: [], tabs: [], active: undefined, files: {},
      ...readLayout(), terminalOpen: false, terminals: [], terminal: undefined, agents: [], agent: undefined, selected: [], anchor: undefined,
    }),
    actions: {
      rooted: (d, root: string) => {
        if (d.root === root) return
        d.root = root
        d.levels = {}
        d.expanded = [root]
        d.selected = []
        d.anchor = undefined
      },
      loading: (d, path: string) => {
        if (d.levels[path]?.kind !== 'ready') d.levels[path] = { kind: 'loading' }
      },
      loaded: (d, path: string, entries: readonly WorkspaceDirectoryEntry[], truncated: boolean) => {
        d.levels[path] = { kind: 'ready', entries, truncated }
      },
      failed: (d, path: string, failure: RemoteFailure) => { d.levels[path] = { kind: 'failed', failure } },
      toggled: (d, path: string) => {
        d.expanded = d.expanded.includes(path) ? d.expanded.filter(value => value !== path) : [...d.expanded, path]
      },
      expandedAt: (d, path: string) => { if (!d.expanded.includes(path)) d.expanded.push(path) },
      opened: (d, path: string, name: string) => {
        if (!d.tabs.includes(path)) d.tabs.push(path)
        d.active = path
        d.files[path] ??= {
          path, name, status: 'loading', baseline: '', disk: '', draft: '', version: '', finalNewline: false, saving: false,
        }
      },
      activated: (d, path: string) => { if (d.tabs.includes(path)) d.active = path },
      closed: (d, path: string) => {
        const index = d.tabs.indexOf(path)
        if (index < 0) return
        d.tabs.splice(index, 1)
        delete d.files[path]
        if (d.active === path) d.active = d.tabs[Math.min(index, d.tabs.length - 1)]
      },
      fileRead: (d, file: OpenFile) => { if (d.tabs.includes(file.path)) d.files[file.path] = file },
      fileFailed: (d, path: string) => {
        const file = fileOf(d, path)
        if (file !== undefined) { file.status = 'failed'; file.error = 'read' }
      },
      disk: (d, path: string, disk: string, version: string, finalNewline: boolean) => {
        const file = fileOf(d, path)
        if (file === undefined) return
        const untouched = file.draft === file.disk
        file.disk = disk
        file.version = version
        file.finalNewline = finalNewline
        if (untouched) file.draft = disk
        file.error = file.error === 'stale' && !untouched ? 'stale' : undefined
      },
      edited: (d, path: string, draft: string) => {
        const file = fileOf(d, path)
        if (file !== undefined) file.draft = draft
      },
      baselineFromDisk: (d, path: string) => {
        const file = fileOf(d, path)
        if (file !== undefined) file.baseline = file.disk
      },
      baselineSet: (d, path: string, baseline: string) => {
        const file = fileOf(d, path)
        if (file !== undefined) file.baseline = baseline
      },
      saving: (d, path: string, saving: boolean, error?: 'save' | 'stale') => {
        const file = fileOf(d, path)
        if (file === undefined) return
        file.saving = saving
        file.error = error
      },
      layout: (d, patch) => { Object.assign(d, patch); writeLayout(d) },
      selection: (d, paths: string[], anchor: string | undefined) => {
        d.selected = paths
        d.anchor = anchor
      },
      agentAdded: (d, id: string) => {
        if (!d.agents.includes(id)) d.agents.push(id)
        d.agent = id
      },
      agentActivated: (d, id: string | undefined) => { if (id === undefined || d.agents.includes(id)) d.agent = id },
      agentClosed: (d, id: string) => {
        d.agents = d.agents.filter(value => value !== id)
        if (d.agent === id) d.agent = d.agents[d.agents.length - 1]
      },
      terminalAdded: (d, key: string) => {
        if (!d.terminals.includes(key)) d.terminals.push(key)
        d.terminal = key
        d.terminalOpen = true
      },
      terminalActivated: (d, key: string) => { if (d.terminals.includes(key)) d.terminal = key },
      terminalClosed: (d, key: string) => {
        const index = d.terminals.indexOf(key)
        if (index < 0) return
        d.terminals.splice(index, 1)
        if (d.terminal === key) d.terminal = d.terminals[Math.min(index, d.terminals.length - 1)]
      },
    },
  })
}
