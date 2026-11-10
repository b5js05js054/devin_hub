// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { IdePage } from '../src/client/IdePage.tsx'
import { createIdeStore } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'

vi.mock('../src/client/CodeEditor.tsx', () => ({
  CodeEditor: ({ path }: { path: string }) => <textarea aria-label={`editor ${path}`} />,
}))

const t = makeTranslate(zh)
const sessionId = 's-test' as SessionId
const source = {
  getSnapshot: () => ({ active: { colorScheme: 'dark' } }) as never,
  subscribe: () => () => {},
}

function mount(overrides: Partial<ComponentProps<typeof IdePage>> = {}) {
  const store = createIdeStore().create()
  store.actions.rooted('C:/repo')
  store.actions.loaded('C:/repo', [{ name: 'a.ts', type: 'file' }, { name: 'src', type: 'directory' }, { name: 'z.ts', type: 'file' }], false)
  store.actions.loaded('C:/repo/src', [{ name: 'nested.ts', type: 'file' }], false)
  const props = {
    sessionId,
    newAgent: vi.fn(),
    closeAgent: vi.fn(),
    revealPath: vi.fn(async () => true),
    mentionFiles: vi.fn(() => true),
    createEntry: vi.fn(async () => true),
    renameEntry: vi.fn(async () => true),
    trashEntry: vi.fn(async () => true),
    useStore: bindSnapshotSelector(store),
    useSessions: selector => selector({ ids: [sessionId], byId: { [sessionId]: { id: sessionId, title: 'test', displayTitle: 'test', running: false, blank: false, updatedAt: 0, cwd: 'C:/repo', retainedBy: {} } }, phase: 'ready', projectionsBySession: {} }),
    useAgents: selector => selector({}),
    loadDir: vi.fn(),
    search: vi.fn(async () => ({ matches: [{ absolutePath: 'C:/repo/a.ts', path: 'a.ts', line: 1, column: 1, text: 'one' }], truncated: false })),
    openFile: store.actions.opened,
    closeFile: store.actions.closed,
    closeDirs: vi.fn(),
    write: vi.fn(),
    acceptPaths: vi.fn(),
    rebase: vi.fn(),
    actions: store.actions,
    useTheme: selector => selector(source.getSnapshot()),
    renderSlot: () => null,
    renderFactorySlot: () => null,
    SessionProvider: ({ children }: { children: ReactNode }) => children,
    t,
    ...overrides,
  } as ComponentProps<typeof IdePage>
  render(<IdePage {...props} />)
  return { store, props }
}

beforeEach(() => {
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)

describe('IdePage file interaction', () => {
  it('opens a file from the tree and navigates with arrows', () => {
    const { store } = mount()
    fireEvent.keyDown(screen.getByRole('treeitem', { name: 'a.ts' }), { key: 'Enter' })
    expect(store.getSnapshot().active).toBe('C:/repo/a.ts')
    const src = screen.getByRole('treeitem', { name: 'src' })
    fireEvent.keyDown(src, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'a.ts' }))
    fireEvent.keyDown(src, { key: 'ArrowRight' })
    expect(store.getSnapshot().expanded).toContain('C:/repo/src')
    fireEvent.keyDown(src, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'nested.ts' }))
    fireEvent.keyDown(screen.getByRole('treeitem', { name: 'nested.ts' }), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(src)
    fireEvent.keyDown(src, { key: 'ArrowLeft' })
    expect(store.getSnapshot().expanded).not.toContain('C:/repo/src')
  })

  it('marks each expanded level with its depth so nested rows indent', () => {
    const { store } = mount()
    expect(screen.getByRole('tree').style.getPropertyValue('--ide-depth')).toBe('')
    act(() => { store.actions.toggled('C:/repo/src') })
    const group = screen.getByRole('group')
    expect(group.style.getPropertyValue('--ide-depth')).toBe('1')
    expect(group.contains(screen.getByRole('treeitem', { name: 'nested.ts' }))).toBe(true)
  })

  it('opens rename and trash confirmations from the keyboard', () => {
    mount()
    const row = screen.getByRole('treeitem', { name: 'a.ts' })
    fireEvent.keyDown(row, { key: 'F2' })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '名称' }).value).toBe('a.ts')
    fireEvent.keyDown(screen.getByRole('textbox', { name: '名称' }), { key: 'Escape' })
    fireEvent.keyDown(row, { key: 'Delete' })
    expect(screen.getByText('将 a.ts 移到回收站？')).not.toBeNull()
  })

  it('closes a tab with Delete and resizes panels with separator arrows', () => {
    const { store } = mount()
    act(() => {
      store.actions.opened('C:/repo/a.ts', 'a.ts')
      store.actions.fileRead({ path: 'C:/repo/a.ts', name: 'a.ts', status: 'ready', baseline: 'one', disk: 'one', draft: 'one', version: '1', finalNewline: false, saving: false })
      store.actions.layout({ filesWidth: 280, terminalOpen: true })
    })
    const tab = screen.getByRole('tab', { name: /^a\.ts/ })
    fireEvent.keyDown(tab, { key: 'Delete' })
    expect(store.getSnapshot().tabs).toEqual([])
    const separator = screen.getByRole('separator', { name: '调整文件栏宽度' })
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(store.getSnapshot().filesWidth).toBe(296)
    fireEvent.keyDown(screen.getByRole('separator', { name: '调整终端高度' }), { key: 'ArrowUp' })
    expect(store.getSnapshot().terminalHeight).toBe(256)
  })

  it('searches across the workspace and opens a content match', async () => {
    const { store, props } = mount()
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true })
    const input = await screen.findByRole('textbox', { name: '搜索工作区' })
    fireEvent.change(input, { target: { value: 'one' } })
    await waitFor(() => { expect(props.search).toHaveBeenCalledWith({ kind: 'files', query: 'one' }, expect.any(AbortSignal)) })
    fireEvent.click(screen.getByRole('button', { name: /^内容$/ }))
    await waitFor(() => { expect(props.search).toHaveBeenCalledWith({ kind: 'content', query: 'one' }, expect.any(AbortSignal)) })
    expect(await screen.findByText('a.ts:1:1')).not.toBeNull()
    fireEvent.click(screen.getByText('a.ts:1:1'))
    expect(store.getSnapshot().active).toBe('C:/repo/a.ts')
    expect(screen.queryByRole('dialog', { name: '搜索工作区' })).toBeNull()
  })
})
