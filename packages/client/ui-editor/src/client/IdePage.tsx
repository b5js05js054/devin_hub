import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, FileTypeIcon, Input, Menu, Modal, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular, IconSearchOutlineRegular,
  IconFolderCloseRegular, IconPanelLeftOutlineRegular, IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { WorkspaceDirectoryEntry, WorkspaceSearchRequest, WorkspaceSearchResult } from '@deepseek-ai/dsh-api-workspace-files/types'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-terminal/client'
import type { IdeActions, IdeInjected } from './face.ts'
import type { AgentReferences } from './agents.ts'
import type { createIdeStore, IdeState, OpenFile } from './store.ts'
import { acceptHunk, computeHunks, rejectHunk, type Hunk } from './hunks.ts'
import css from './Ide.module.css'

const CodeEditor = lazy(async () => ({ default: (await import('./CodeEditor.tsx')).CodeEditor }))
const NO_HUNKS: readonly Hunk[] = []

/** Inject face of the IDE page: Session-bound actions plus the theme observable. */
export interface IdeFace extends IdeInjected {
  /** Insert `@path` mentions into one Session's composer; false when it cannot accept them now. */
  readonly mentionFiles: (sessionId: string, files: readonly { readonly path: string; readonly directory: boolean }[]) => boolean
  /** Show one path in the Host file manager; false when the Host refused or is unreachable. */
  readonly revealPath: (path: string) => Promise<boolean>
  readonly newAgent: () => void
  readonly closeAgent: (id: string) => void
  readonly hooks: { readonly theme: HostObservable<ThemeSnapshot>; readonly agents: HostObservable<AgentReferences> }
}

const DRAG_TYPE = 'application/x-dsh-workspace-entry'

/** Props the IDE page receives. */
export type IdePageProps =
  & PropsRuntime<'ide.workspace'>
  & PropsLocale<'ide'>
  & PropsStore<ReturnType<typeof createIdeStore>>
  & InjectFace<IdeFace>
  & PropsRenderFactories
  & PropsRenderSlots<'ide.agent'>
/** Props of the thin `main` page that hosts the workspace. */
export type IdeMainProps = PropsRuntime<'main'> & PropsRenderSlots<'ide.workspace'>

/**
 * The `main` page registered under the IDE panel id.
 * @param props - main slot share with the declared workspace child.
 * @returns the workspace slot.
 */
export function IdeMain({ renderSlot }: IdeMainProps): ReactNode {
  return renderSlot('ide.workspace', {})
}

function ChatView(props: ConversationViewsProps): ReactNode {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>
}

const MIN = 160
const TERMINAL_MAX = 640
const FILES_MAX = 520
const AGENT_MAX = 720

function sortEntries(entries: readonly WorkspaceDirectoryEntry[]): WorkspaceDirectoryEntry[] {
  return [...entries].sort((a, b) => {
    const dir = Number(b.type === 'directory') - Number(a.type === 'directory')
    return dir !== 0 ? dir : a.name.localeCompare(b.name)
  })
}

function child(parent: string, name: string): string {
  return `${parent.replace(/[/\\]+$/, '')}/${name}`
}

interface TreeRow { readonly path: string; readonly directory: boolean }

function parentOf(path: string): string {
  return path.replace(/[/\\][^/\\]*$/, '')
}

function visibleRows(state: IdeState, path: string, out: TreeRow[] = []): TreeRow[] {
  const level = state.levels[path]
  if (level?.kind !== 'ready') return out
  for (const entry of sortEntries(level.entries)) {
    const full = child(path, entry.name)
    const directory = entry.type === 'directory'
    out.push({ path: full, directory })
    if (directory && state.expanded.includes(full)) visibleRows(state, full, out)
  }
  return out
}

/**
 * Open files under any of `paths` whose editor text differs from disk.
 * @param state - the IDE state.
 * @param paths - entries about to be closed, renamed, or trashed.
 * @returns the dirty open files that would lose their draft.
 */
function dirtyUnder(state: IdeState, paths: readonly string[]): OpenFile[] {
  return Object.values(state.files).filter(file => file.draft !== file.disk
    && paths.some(path => file.path === path || file.path.startsWith(`${path}/`) || file.path.startsWith(`${path}\\`)))
}

/** Apply a Ctrl/Cmd or Shift click to the selection; false for a plain click, which the caller handles. */
function extendSelection(event: MouseEvent<HTMLElement>, path: string, state: IdeState, actions: IdeActions): boolean {
  if (event.shiftKey && state.anchor !== undefined && state.root !== undefined) {
    const rows = visibleRows(state, state.root).map(row => row.path)
    const from = rows.indexOf(state.anchor)
    const to = rows.indexOf(path)
    if (from >= 0 && to >= 0) {
      actions.selection(rows.slice(Math.min(from, to), Math.max(from, to) + 1), state.anchor)
      return true
    }
  }
  if (event.ctrlKey || event.metaKey) {
    actions.selection(state.selected.includes(path) ? state.selected.filter(value => value !== path) : [...state.selected, path], path)
    return true
  }
  return false
}

function startDrag(event: DragEvent<HTMLElement>, path: string, directory: boolean, state: IdeState): void {
  const dragged = state.selected.includes(path) && state.selected.length > 1 && state.root !== undefined
    ? visibleRows(state, state.root).filter(row => state.selected.includes(row.path))
    : [{ path, directory }]
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragged))
  event.dataTransfer.setData('text/plain', dragged.map(row => row.path).join('\n'))
}

function isEntryDrag(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes(DRAG_TYPE)
}

function Tree({ path, depth, state, props, onMenu, onKeyDown }: { path: string; depth: number; state: IdeState; props: IdePageProps; onMenu: (event: MouseEvent, path: string) => void; onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, path: string, directory: boolean, parent: string) => void }): ReactNode {
  const level = state.levels[path]
  const { t, loadDir, openFile, actions } = props
  if (level === undefined || level.kind === 'loading') return <li className={css.note}>{t('loading')}</li>
  if (level.kind === 'failed') {
    return <li className={css.note}>{t('loadFailed')} <button type="button" onClick={() => { loadDir(path) }}>{t('retry')}</button></li>
  }
  return (
    <>
      {sortEntries(level.entries).map((entry) => {
        const full = child(path, entry.name)
        if (entry.type === 'directory') {
          const open = state.expanded.includes(full)
          return (
            <li key={entry.name}>
              <button
                type="button" role="treeitem" aria-selected={state.selected.includes(full)} tabIndex={state.selected.includes(full) || state.selected.length === 0 ? 0 : -1} data-ide-path={full} className={css.row} aria-expanded={open}
                onFocus={() => { actions.selection([full], full) }}
                onKeyDown={event => { onKeyDown(event, full, true, path) }}
                data-selected={state.selected.includes(full) ? '' : undefined}
                draggable
                onContextMenu={(event) => { onMenu(event, full) }}
                onDragStart={(event) => { startDrag(event, full, true, state) }}
                onClick={(event) => {
                  if (extendSelection(event, full, state, actions)) return
                  actions.selection([full], full)
                  actions.toggled(full)
                  if (!open && state.levels[full] === undefined) loadDir(full)
                }}
              >
                {open ? <IconChevronDownOutlineRegular size={14} /> : <IconChevronRightOutlineRegular size={14} />}
                <IconFolderCloseRegular size={16} />
                <span className={css.name} title={entry.name}>{entry.name}</span>
              </button>
              {open && <ul role="group" style={{ '--ide-depth': depth + 1 } as CSSProperties}><Tree path={full} depth={depth + 1} state={state} props={props} onMenu={onMenu} onKeyDown={onKeyDown} /></ul>}
            </li>
          )
        }
        const file = state.files[full]
        const pending = file !== undefined && file.baseline !== file.disk
        return (
          <li key={entry.name}>
            <button
              type="button" role="treeitem" aria-selected={state.selected.includes(full)} tabIndex={state.selected.includes(full) || state.selected.length === 0 ? 0 : -1} data-ide-path={full} className={css.row} data-active={state.active === full ? '' : undefined}
              onFocus={() => { actions.selection([full], full) }}
              onKeyDown={event => { onKeyDown(event, full, false, path) }}
              data-selected={state.selected.includes(full) ? '' : undefined}
              draggable
              onContextMenu={(event) => { onMenu(event, full) }}
              onDragStart={(event) => { startDrag(event, full, false, state) }}
              onClick={(event) => {
                if (extendSelection(event, full, state, actions)) return
                actions.selection([full], full)
                openFile(full, entry.name)
              }}
            >
              <FileTypeIcon path={entry.name} size={16} />
              <span className={css.name} title={entry.name}>{entry.name}</span>
              {pending && <span className={css.mark} title={t('reviewTitle')} />}
            </button>
          </li>
        )
      })}
      {level.truncated && <li className={css.note}>{t('listTruncated')}</li>}
    </>
  )
}

function useDragY(height: number, set: (px: number) => void) {
  const origin = useRef<{ y: number; height: number } | undefined>(undefined)
  return {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      origin.current = { y: event.clientY, height }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (origin.current === undefined) return
      set(Math.min(TERMINAL_MAX, Math.max(MIN, origin.current.height - (event.clientY - origin.current.y))))
    },
    onPointerUp: () => { origin.current = undefined },
  }
}

function useDrag(width: number, side: 'left' | 'right', max: number, set: (px: number) => void) {
  const origin = useRef<{ x: number; width: number } | undefined>(undefined)
  return {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      origin.current = { x: event.clientX, width }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (origin.current === undefined) return
      const delta = (event.clientX - origin.current.x) * (side === 'left' ? 1 : -1)
      set(Math.min(max, Math.max(MIN, origin.current.width + delta)))
    },
    onPointerUp: () => { origin.current = undefined },
  }
}

/**
 * Review controls pinned above one changed block inside the editor.
 * @param props - the block, its file, the review actions, and translated copy.
 * @returns the strip contents.
 */
function HunkStrip({ hunk, path, accept, reject, t }: {
  readonly hunk: Hunk
  readonly path: string
  readonly accept: (path: string, hunk?: Hunk) => void
  readonly reject: (path: string, hunk?: Hunk) => void
  readonly t: IdePageProps['t']
}): ReactNode {
  const added = hunk.modifiedEnd === 0 ? 0 : hunk.modifiedEnd - hunk.modifiedStart + 1
  const removed = Math.max(hunk.originalEnd - hunk.originalStart + 1, 0)
  const counts = [
    added > 0 ? t('blockAdded', { count: added }) : '',
    removed > 0 ? t('blockRemoved', { count: removed }) : '',
  ].filter(Boolean).join(' ')
  return (
    <span className={css.hunkAction}>
      <span className={css.hunkLabel}>{`L${Math.max(hunk.modifiedStart, 1)} · ${counts}`}</span>
      <span className={css.spacer} />
      <Button variant="outline" size="sm" onClick={() => { accept(path, hunk) }}>{t('accept')}</Button>
      <Button variant="ghost" size="sm" onClick={() => { reject(path, hunk) }}>{t('reject')}</Button>
    </span>
  )
}

type SearchMode = WorkspaceSearchRequest['kind']
type SearchStatus = { kind: 'idle' | 'loading' | 'failed' } | { kind: 'ready'; result: WorkspaceSearchResult }

interface WorkspaceSearchProps {
  readonly open: boolean
  readonly initialMode: SearchMode
  readonly search: (request: WorkspaceSearchRequest, signal: AbortSignal) => Promise<WorkspaceSearchResult>
  readonly openMatch: (match: WorkspaceSearchResult['matches'][number]) => void
  readonly onClose: () => void
  readonly t: IdePageProps['t']
}

function WorkspaceSearch(props: WorkspaceSearchProps): ReactNode {
  const { open, initialMode, search, openMatch, onClose, t } = props
  const [mode, setMode] = useState<SearchMode>(initialMode)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<SearchStatus>({ kind: 'idle' })
  const [selected, setSelected] = useState(0)
  const trimmed = query.trim()
  useEffect(() => {
    if (!open || trimmed === '') { setStatus({ kind: 'idle' }); return }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setStatus({ kind: 'loading' })
      void search({ kind: mode, query: trimmed }, controller.signal).then(
        result => { if (!controller.signal.aborted) setStatus({ kind: 'ready', result }) },
        () => { if (!controller.signal.aborted) setStatus({ kind: 'failed' }) },
      )
    }, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [open, trimmed, mode, search])
  const matches = status.kind === 'ready' ? status.result.matches : []
  const active = Math.min(selected, Math.max(0, matches.length - 1))
  const move = (event: React.KeyboardEvent, step: number): void => {
    event.preventDefault()
    if (matches.length > 0) setSelected((active + step + matches.length) % matches.length)
  }
  return <Modal open={open} onClose={onClose} title={t('searchWorkspace')} headless className={css.searchDialog as string}>
    <div className={css.searchHead}>
      <Input icon={<IconSearchOutlineRegular size={16} />} value={query} data-modal-autofocus
        aria-label={t('searchWorkspace')} placeholder={t(mode === 'files' ? 'searchPlaceholder' : 'contentPlaceholder')}
        onChange={event => { setQuery(event.currentTarget.value); setSelected(0) }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') move(event, 1)
          if (event.key === 'ArrowUp') move(event, -1)
          if (event.key === 'Enter') { event.preventDefault(); const match = matches[active]; if (match !== undefined) openMatch(match) }
        }} />
      <div className={css.searchModes} role="group" aria-label={t('searchWorkspace')}>
        <Button size="sm" variant={mode === 'files' ? 'outline' : 'ghost'} aria-pressed={mode === 'files'} onClick={() => { setMode('files'); setSelected(0) }}>{t('searchFiles')}</Button>
        <Button size="sm" variant={mode === 'content' ? 'outline' : 'ghost'} aria-pressed={mode === 'content'} onClick={() => { setMode('content'); setSelected(0) }}>{t('searchContentMode')}</Button>
      </div>
    </div>
    <div className={css.searchResults}>
      {status.kind === 'loading' && <div className={css.empty} role="status">{t('searching')}</div>}
      {status.kind === 'failed' && <div className={css.error} role="alert">{t('searchFailed')}</div>}
      {status.kind === 'ready' && matches.length === 0 && <div className={css.empty}>{t('searchEmpty')}</div>}
      {status.kind === 'ready' && status.result.truncated && <div className={css.searchNotice}>{t('searchTruncated')}</div>}
      {matches.map((match, index) => <button type="button" key={`${match.absolutePath}:${match.line ?? 0}:${match.column ?? 0}`} className={css.searchResult}
        data-active={index === active ? '' : undefined} onMouseEnter={() => { setSelected(index) }} onClick={() => { openMatch(match) }}>
        <span className={css.searchPath}>{match.path}{match.line !== undefined ? `:${match.line}:${match.column}` : ''}</span>
        {match.text !== undefined && <span className={css.searchText}>{match.text}</span>}
      </button>)}
    </div>
  </Modal>
}

/**
 * Three-column IDE page: workspace file tree, Monaco editor with reviewable Agent edits, Session conversation.
 * @param props - store share, injected face, and the declared conversation slot.
 * @returns the page element.
 */
export function IdePage(props: IdePageProps): ReactNode {
  const { t, useStore, actions, loadDir, closeFile, write, useTheme, useSessions, sessionId, renderFactorySlot } = props
  const state = useStore(value => value)
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  const theme = useTheme(value => value.active.colorScheme)
  const agentRefs = props.useAgents(value => value)
  const agentIds = [undefined, ...state.agents]
  const [dropState, setDropState] = useState<'idle' | 'over'>('idle')
  const [dropFailed, setDropFailed] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | undefined>(undefined)
  const [revealFailed, setRevealFailed] = useState(false)
  const [dialog, setDialog] = useState<{ kind: 'newFile' | 'newFolder' | 'rename' | 'trash'; path: string; paths?: readonly string[] } | undefined>(undefined)
  const [dialogName, setDialogName] = useState('')
  const [dialogInvalid, setDialogInvalid] = useState(false)
  const [discard, setDiscard] = useState<{ count: number; run: () => void } | undefined>(undefined)
  const [search, setSearch] = useState<SearchMode | undefined>(undefined)
  const [revealLine, setRevealLine] = useState<{ path: string; line: number; column: number; revision: number } | undefined>(undefined)
  const revealRevision = useRef(0)
  const [closingTerminals, setClosingTerminals] = useState<ReadonlySet<string>>(new Set())
  const openSearchResult = (match: WorkspaceSearchResult['matches'][number]): void => {
    props.openFile(match.absolutePath, match.path.split('/').pop() ?? match.path)
    if (match.line !== undefined) setRevealLine({ path: match.absolutePath, line: match.line, column: match.column ?? 1, revision: ++revealRevision.current })
    setSearch(undefined)
  }
  const requestClose = (path: string): void => {
    const count = dirtyUnder(state, [path]).length
    if (count > 0) setDiscard({ count, run: () => { closeFile(path) } })
    else closeFile(path)
  }
  const openMenu = (event: MouseEvent, path: string): void => {
    event.preventDefault()
    setRevealFailed(false)
    setMenu({ x: event.clientX, y: event.clientY, path })
  }
  const dropHandlers = {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!isEntryDrag(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setDropState('over')
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropState('idle')
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!isEntryDrag(event)) return
      event.preventDefault()
      event.stopPropagation()
      setDropState('idle')
      const entries = JSON.parse(event.dataTransfer.getData(DRAG_TYPE)) as { path: string; directory: boolean }[]
      setDropFailed(!props.mentionFiles(state.agent ?? sessionId, entries))
    },
  }

  useEffect(() => {
    if (cwd === undefined) return
    actions.rooted(cwd)
    loadDir(cwd)
    return props.closeDirs
  }, [cwd, sessionId])


  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      if (event.key.toLowerCase() === 'p' && !event.shiftKey) { event.preventDefault(); setSearch('files') }
      if (event.key.toLowerCase() === 'f' && event.shiftKey) { event.preventDefault(); setSearch('content') }
    }
    window.addEventListener('keydown', listener)
    return () => { window.removeEventListener('keydown', listener) }
  }, [])

  const save = (path: string): void => {
    const current = state.files[path]
    if (current !== undefined) write(path, current.draft)
  }
  const accept = (path: string, hunk?: Hunk): void => {
    const current = state.files[path]
    if (current !== undefined) actions.baselineSet(path, hunk === undefined ? current.disk : acceptHunk(current.baseline, current.disk, hunk))
  }
  const reject = (path: string, hunk?: Hunk): void => {
    const current = state.files[path]
    if (current !== undefined) write(path, hunk === undefined ? current.baseline : rejectHunk(current.baseline, current.disk, hunk))
  }

  const file = state.active === undefined ? undefined : state.files[state.active]
  const pendingHunks = useMemo(
    () => (file === undefined || file.status !== 'ready' || file.image !== undefined ? [] : computeHunks(file.baseline, file.disk)),
    [file?.baseline, file?.disk, file?.status, file?.image],
  )
  const draftClean = file !== undefined && file.draft === file.disk
  const hunks = draftClean ? pendingHunks : NO_HUNKS
  const filesDrag = useDrag(state.filesWidth, 'left', FILES_MAX, px => { actions.layout({ filesWidth: px }) })
  const terminalDrag = useDragY(state.terminalHeight, px => { actions.layout({ terminalHeight: px }) })
  const agentDrag = useDrag(state.agentWidth, 'right', AGENT_MAX, px => { actions.layout({ agentWidth: px }) })
  const resizeKey = (event: React.KeyboardEvent, current: number, apply: (value: number) => void, min: number, max: number, reversed = false): void => {
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -16 : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 16 : event.key === 'Home' ? min - current : event.key === 'End' ? max - current : 0
    if (delta === 0) return
    event.preventDefault()
    apply(Math.max(min, Math.min(max, current + (reversed ? -delta : delta))))
  }
  const treeRef = useRef<HTMLUListElement>(null)
  const treeKey = (event: React.KeyboardEvent<HTMLButtonElement>, path: string, directory: boolean, parent: string): void => {
    const rows = state.root === undefined ? [] : visibleRows(state, state.root)
    const index = rows.findIndex(row => row.path === path)
    const focus = (next: string): void => {
      actions.selection([next], next)
      const element = [...(treeRef.current?.querySelectorAll<HTMLElement>('[data-ide-path]') ?? [])].find(item => item.dataset.idePath === next)
      element?.focus()
      element?.scrollIntoView({ block: 'nearest' })
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const next = event.key === 'Home' ? rows[0] : event.key === 'End' ? rows.at(-1) : rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]
      if (next !== undefined) focus(next.path)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      if (directory && state.expanded.includes(path) !== (event.key === 'ArrowRight')) actions.toggled(path)
      else if (event.key === 'ArrowRight') { const next = rows[index + 1]; if (next !== undefined && next.path.startsWith(`${path}/`)) focus(next.path) }
      else if (rows.some(row => row.path === parent)) focus(parent)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (directory) { actions.toggled(path); if (state.levels[path] === undefined) loadDir(path) }
      else props.openFile(path, path.split(/[/\\]/).pop() ?? path)
    } else if (event.key === 'F2' || event.key === 'Delete') {
      event.preventDefault()
      setDialog({ kind: event.key === 'F2' ? 'rename' : 'trash', path, paths: [path] })
      setDialogName(event.key === 'F2' ? path.split(/[/\\]/).pop() ?? '' : '')
    }
  }

  const columns = [
    state.filesCollapsed ? '32px' : `${state.filesWidth}px`,
    '0',
    'minmax(0, 1fr)',
    '0',
    state.agentCollapsed ? '32px' : `${state.agentWidth}px`,
  ].join(' ')

  return (
    <div className={css.root} style={{ gridTemplateColumns: columns }} data-ide="">
      <section className={clsx(css.column, css.filesCol)} aria-label={t('files')} data-ide-column="files">
        {state.filesCollapsed
          ? (
            <div className={css.rail}>
              <Button variant="ghost" size="sm" aria-label={t('expandFiles')} icon={<IconPanelLeftOutlineRegular size={16} />} onClick={() => { actions.layout({ filesCollapsed: false }) }} />
            </div>
          )
          : (
            <>
              <div className={css.header}>
                <span>{t('files')}</span>
                <span>
                  <Button variant="ghost" size="sm" aria-label={t('searchWorkspace')} icon={<IconSearchOutlineRegular size={16} />} onClick={() => { setSearch('files') }} />
                  <Button variant="ghost" size="sm" aria-label={t('refresh')} icon={<IconRefreshOutlineRegular size={16} />} onClick={() => { if (state.root !== undefined) loadDir(state.root) }} />
                  <Button variant="ghost" size="sm" aria-label={t('collapseFiles')} icon={<IconPanelLeftOutlineRegular size={16} />} onClick={() => { actions.layout({ filesCollapsed: true }) }} />
                </span>
              </div>
              {state.root === undefined
                ? <div className={css.empty}>{t('noWorkspace')}</div>
                : <ul ref={treeRef} className={css.tree} role="tree" aria-label={t('files')}><Tree path={state.root} depth={0} state={state} props={props} onMenu={openMenu} onKeyDown={treeKey} /></ul>}
              {menu !== undefined && (
                <Menu
                  open portal compact anchor={<span />} side="right"
                  getAnchorRect={() => new DOMRect(menu.x, menu.y, 0, 0)}
                  items={[
                    { id: 'newFile', label: t('newFile') },
                    { id: 'newFolder', label: t('newFolder') },
                    { type: 'separator', id: 'sep0' },
                    { id: 'reveal', label: t('revealInExplorer') },
                    { id: 'mention', label: t('mentionInChat') },
                    { type: 'separator', id: 'sep' },
                    { id: 'copyPath', label: t('copyPath') },
                    { id: 'copyRelativePath', label: t('copyRelativePath') },
                    { type: 'separator', id: 'sep2' },
                    { id: 'rename', label: t('renameEntry') },
                    { id: 'trash', label: t('trashEntry') },
                  ]}
                  onSelect={(id) => {
                    const target = menu.path
                    setMenu(undefined)
                    if (id === 'newFile' || id === 'newFolder') {
                      const directory = state.root !== undefined && visibleRows(state, state.root).find(row => row.path === target)?.directory
                      setDialog({ kind: id, path: directory === false ? parentOf(target) : target })
                      setDialogName('')
                      return
                    }
                    if (id === 'rename' || id === 'trash') {
                      const picked = id === 'trash' && state.selected.length > 1 && state.selected.includes(target) ? state.selected : [target]
                      const paths = picked.filter(path => !picked.some(other => other !== path && (path.startsWith(`${other}/`) || path.startsWith(`${other}\\`))))
                      setDialog({ kind: id, path: target, paths })
                      setDialogName(target.split(/[/\\]/).pop() ?? '')
                      return
                    }
                    if (id === 'reveal') {
                      void props.revealPath(target).then((ok) => { setRevealFailed(!ok) })
                      return
                    }
                    if (id === 'mention') {
                      const rows = state.root === undefined ? [] : visibleRows(state, state.root)
                      const picked = state.selected.length > 1 && state.selected.includes(target) ? state.selected : [target]
                      const entries = picked.map(path => ({ path, directory: rows.find(row => row.path === path)?.directory === true }))
                      setDropFailed(!props.mentionFiles(state.agent ?? sessionId, entries))
                      return
                    }
                    const root = state.root ?? ''
                    const sep = root.includes('\\') ? '\\' : '/'
                    const relative = target.slice(root.replace(/[/\\]+$/, '').length).replace(/^[/\\]+/, '')
                    const text = id === 'copyPath' ? target.replaceAll('/', sep) : relative.replaceAll('/', sep)
                    void navigator.clipboard.writeText(text).catch(() => { setRevealFailed(true) })
                  }}
                  onClose={() => { setMenu(undefined) }}
                />
              )}
              {dialog !== undefined && (
                <form
                  className={css.dialog}
                  onKeyDown={(event) => { if (event.key === 'Escape') { setDialog(undefined); setDialogInvalid(false) } }}
                  onSubmit={(event) => {
                    event.preventDefault()
                    const name = dialogName.trim()
                    if (dialog.kind !== 'trash' && (name === '' || name === '.' || name === '..' || /[/\\]/.test(name))) {
                      setDialogInvalid(true)
                      return
                    }
                    const perform = (): void => {
                      const done = dialog.kind === 'trash'
                        ? (async () => {
                          let ok = true
                          for (const path of dialog.paths ?? [dialog.path]) ok = (await props.trashEntry(path)) && ok
                          return ok
                        })()
                        : dialog.kind === 'rename' ? props.renameEntry(dialog.path, child(parentOf(dialog.path), name))
                          : props.createEntry(child(dialog.path, name), dialog.kind === 'newFile' ? 'file' : 'directory')
                      void done.then((ok) => {
                        setRevealFailed(!ok)
                        if (!ok) setTimeout(() => { setRevealFailed(false) }, 6000)
                      })
                    }
                    setDialog(undefined)
                    setDialogInvalid(false)
                    const affected = dialog.kind === 'trash' || dialog.kind === 'rename' ? dirtyUnder(state, dialog.paths ?? [dialog.path]) : []
                    if (affected.length > 0) setDiscard({ count: affected.length, run: perform })
                    else perform()
                  }}
                >
                  {dialog.kind === 'trash'
                    ? <span>{(dialog.paths?.length ?? 1) > 1 ? t('trashConfirmMany', { count: dialog.paths?.length ?? 1 }) : t('trashConfirm', { name: dialog.path.split(/[/\\]/).pop() ?? dialog.path })}</span>
                    : <input autoFocus aria-label={t('nameInput')} value={dialogName} onChange={(event) => { setDialogName(event.target.value); setDialogInvalid(false) }} />}
                  {dialogInvalid && <span className={css.error} role="alert">{t('invalidName')}</span>}
                  <span>
                    <Button type="submit" size="sm" variant="ghost">{t('confirm')}</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => { setDialog(undefined); setDialogInvalid(false) }}>{t('cancel')}</Button>
                  </span>
                </form>
              )}
              {revealFailed && <div className={css.error} role="alert" onClick={() => { setRevealFailed(false) }}>{t('revealFailed')}</div>}
            </>
          )}
      </section>
      <div
        className={css.handle} role="separator" tabIndex={0} aria-valuenow={state.filesWidth} aria-valuemin={MIN} aria-valuemax={FILES_MAX} aria-orientation="vertical" aria-label={t('resizeFiles')}
        onKeyDown={event => { resizeKey(event, state.filesWidth, value => actions.layout({ filesWidth: value }), MIN, FILES_MAX) }} {...filesDrag}
      />
      <section className={css.center} data-ide-column="editor">
        <div className={css.tabs} role="tablist">
          {state.tabs.map((path) => {
            const open = state.files[path]
            const dirty = open !== undefined && open.draft !== open.disk
            return (
              <button
                key={path} type="button" role="tab" className={css.tab}
                data-active={path === state.active ? '' : undefined}
                aria-selected={path === state.active}
                data-ide-tab={path}
                tabIndex={path === state.active ? 0 : -1}
                onClick={() => { actions.activated(path) }}
                onMouseDown={(event) => { if (event.button === 1) event.preventDefault() }}
                onAuxClick={(event) => { if (event.button === 1) requestClose(path) }}
                onKeyDown={(event) => {
                  if (event.key === 'Delete') { event.preventDefault(); requestClose(path); return }
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return
                  event.preventDefault()
                  const index = state.tabs.indexOf(path)
                  const next = event.key === 'Home' ? state.tabs[0] : event.key === 'End' ? state.tabs.at(-1) : state.tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + state.tabs.length) % state.tabs.length]
                  if (next !== undefined) { actions.activated(next); document.querySelector<HTMLElement>(`[data-ide-tab="${next}"]`)?.focus() }
                }}
              >
                <span>{open?.name ?? path}</span>
                {dirty && <span className={css.dot} title={t('unsavedMark')} />}
                {open !== undefined && open.baseline !== open.disk && <span className={css.mark} title={t('reviewTitle')} />}
                <span
                  role="button" tabIndex={0} aria-label={t('closeTab', { name: open?.name ?? path })}
                  onClick={(event) => { event.stopPropagation(); requestClose(path) }}
                  onKeyDown={(event) => { if (event.key === 'Enter') requestClose(path) }}
                >
                  <IconCloseOutlineRegular size={12} />
                </span>
              </button>
            )
          })}
        </div>
        {file === undefined && <div className={css.empty}>{t('emptyEditor')}</div>}
        {file?.status === 'loading' && <div className={css.empty}>{t('loading')}</div>}
        {file?.status === 'failed' && <div className={css.error}>{t('readFailed')}</div>}
        {file?.status === 'ready' && file.image !== undefined && (
          <div className={css.imageBody}><img src={file.image} alt={file.name} draggable={false} /></div>
        )}
        {file?.status === 'ready' && file.image === undefined && (
          <>
            {pendingHunks.length > 0 && (
              <div className={css.review} data-ide-review="">
                <strong>{t('reviewTitle')}</strong>
                <span>{t('hunks', { count: pendingHunks.length })}</span>
                <span className={css.spacer} />
                <Button variant="outline" size="sm" onClick={() => { accept(file.path) }}>{t('acceptAll')}</Button>
                <Button variant="outline" size="sm" disabled={!draftClean} title={draftClean ? undefined : t('unsavedMark')} onClick={() => { reject(file.path) }}>{t('rejectAll')}</Button>
              </div>
            )}
            {(!draftClean || file.saving) && (
              <div className={css.review}>
                <span>{t('unsavedMark')}</span>
                <span className={css.spacer} />
                <Button variant="outline" size="sm" disabled={file.saving} onClick={() => { save(file.path) }}>{t('save')}</Button>
              </div>
            )}
            {file.error !== undefined && (
              <div className={css.error}>{file.error === 'stale' ? t('staleConflict') : t('saveFailed')}</div>
            )}
            <div className={css.body}>
              <Suspense fallback={<div className={css.empty}>{t('loading')}</div>}>
                <CodeEditor
                  path={file.path} baseline={file.baseline} text={file.draft} hunks={hunks} dark={theme === 'dark'}
                  reveal={revealLine?.path === file.path ? revealLine : undefined}
                  onChange={(text) => { actions.edited(file.path, text) }}
                  onSave={() => { save(file.path) }}
                  renderHunkActions={(hunk) => <HunkStrip hunk={hunk} path={file.path} accept={accept} reject={reject} t={t} />}
                />
              </Suspense>
            </div>
          </>
        )}
        {state.terminalOpen && (
          <div className={css.termHandle} role="separator" tabIndex={0} aria-valuenow={state.terminalHeight} aria-valuemin={MIN} aria-valuemax={TERMINAL_MAX} aria-orientation="horizontal" aria-label={t('resizeTerminal')} onKeyDown={event => { resizeKey(event, state.terminalHeight, value => actions.layout({ terminalHeight: value }), MIN, TERMINAL_MAX, true) }} {...terminalDrag} />
        )}
        <div className={css.termBar}>
          <div className={css.termTabs} role="tablist" aria-label={t('terminal')}>
            <span>{t('terminal')}</span>
            {state.terminals.map((key, index) => (
              <span key={key} className={css.termTab} data-active={key === state.terminal ? '' : undefined}>
                <button type="button" role="tab" aria-selected={key === state.terminal} className={css.termTabButton} onClick={() => { actions.terminalActivated(key) }}>
                  {`${t('terminal')} ${index + 1}`}
                </button>
                <button type="button" className={css.termTabButton} aria-label={t('closeTerminal')} onClick={() => { setClosingTerminals(value => new Set(value).add(key)) }}>
                  <IconCloseOutlineRegular size={12} />
                </button>
              </span>
            ))}
            <Button variant="ghost" size="sm" aria-label={t('newTerminal')} onClick={() => { actions.terminalAdded(crypto.randomUUID().slice(0, 8)) }}>+</Button>
          </div>
          <Button
            variant="ghost" size="sm" aria-label={t('toggleTerminal')} aria-expanded={state.terminalOpen}
            icon={state.terminalOpen ? <IconChevronDownOutlineRegular size={14} /> : <IconChevronRightOutlineRegular size={14} />}
            onClick={() => { actions.layout({ terminalOpen: !state.terminalOpen }) }}
          />
        </div>
        <div className={css.termBody} style={{ height: state.terminalOpen ? state.terminalHeight : 0, display: state.terminalOpen ? undefined : 'none' }}>
          {state.terminals.length === 0 && <Button variant="outline" size="sm" onClick={() => { actions.terminalAdded(crypto.randomUUID().slice(0, 8)) }}>{t('newTerminal')}</Button>}
          {state.terminals.map(key => (
            <div key={key} style={{ height: '100%', display: key === state.terminal ? undefined : 'none' }}>
              {renderFactorySlot('terminal.embedded', {
                terminalKey: key, active: key === state.terminal && state.terminalOpen, closing: closingTerminals.has(key),
                onClosed: () => { actions.terminalClosed(key); setClosingTerminals(value => { const next = new Set(value); next.delete(key); return next }) },
              })}
            </div>
          ))}
        </div>
      </section>
      <div
        className={css.handle} role="separator" tabIndex={0} aria-valuenow={state.agentWidth} aria-valuemin={MIN} aria-valuemax={AGENT_MAX} aria-orientation="vertical" aria-label={t('resizeAgent')}
        onKeyDown={event => { resizeKey(event, state.agentWidth, value => actions.layout({ agentWidth: value }), MIN, AGENT_MAX, true) }} {...agentDrag}
      />
      <section
        className={clsx(css.column, css.agentCol)} data-ide-column="agent" data-drop={dropState === 'over' ? '' : undefined}
        {...dropHandlers}
      >
        {state.agentCollapsed
          ? (
            <div className={css.rail}>
              <Button variant="ghost" size="sm" aria-label={t('expandAgent')} icon={<IconPanelLeftOutlineRegular size={16} />} onClick={() => { actions.layout({ agentCollapsed: false }) }} />
            </div>
          )
          : (
            <>
              <div className={css.agentTabs} role="tablist" aria-label={t('agentTabs')}>
                {agentIds.map((id, index) => (
                  <button
                    key={id ?? 'own'} type="button" role="tab" className={css.tab}
                    data-active={id === state.agent ? '' : undefined} aria-selected={id === state.agent}
                    onClick={() => { actions.agentActivated(id) }}
                  >
                    <span>{t('agentTab', { index: index + 1 })}</span>
                    {id !== undefined && (
                      <span
                        role="button" tabIndex={0} aria-label={t('closeAgent', { index: index + 1 })}
                        onClick={(event) => { event.stopPropagation(); props.closeAgent(id) }}
                        onKeyDown={(event) => { if (event.key === 'Enter') props.closeAgent(id) }}
                      >
                        <IconCloseOutlineRegular size={12} />
                      </span>
                    )}
                  </button>
                ))}
                <Button variant="ghost" size="sm" aria-label={t('newAgent')} onClick={() => { props.newAgent() }}>+</Button>
                <span className={css.spacer} />
                <Button variant="ghost" size="sm" aria-label={t('collapseAgent')} icon={<IconPanelLeftOutlineRegular size={16} />} onClick={() => { actions.layout({ agentCollapsed: true }) }} />
              </div>
              {dropFailed && <div className={css.error} role="alert" onClick={() => { setDropFailed(false) }}>{t('dropFailed')}</div>}
              {agentIds.map((id) => {
                const conversation = renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, { slots: { views: ChatView } })
                const reference = id === undefined ? undefined : agentRefs[id]
                if (id !== undefined && reference === undefined) return null
                return (
                  <div key={id ?? 'own'} className={css.agentBody} hidden={id !== state.agent}>
                    {reference === undefined ? conversation : <props.SessionProvider session={reference}>{conversation}</props.SessionProvider>}
                  </div>
                )
              })}
            </>
          )}
      </section>
      {discard !== undefined && (
        <form
          className={css.discard} role="alertdialog" aria-label={t('discardTitle')}
          onSubmit={(event) => { event.preventDefault(); const { run } = discard; setDiscard(undefined); run() }}
          onKeyDown={(event) => { if (event.key === 'Escape') setDiscard(undefined) }}
        >
          <span>{t('discardConfirm', { count: discard.count })}</span>
          <span>
            <Button type="submit" size="sm" variant="outline" autoFocus>{t('discard')}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setDiscard(undefined) }}>{t('cancel')}</Button>
          </span>
        </form>
      )}
      {search !== undefined && <WorkspaceSearch key={search} open initialMode={search} search={props.search} openMatch={openSearchResult} onClose={() => { setSearch(undefined) }} t={t} />}
    </div>
  )
}
