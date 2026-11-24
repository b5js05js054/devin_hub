// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
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

function mount(overrides: Partial<ComponentProps<typeof IdePage>> = {}, root: string | null = 'C:/repo') {
  const store = createIdeStore().create()
  if (root !== null) {
    store.actions.rooted(root)
    store.actions.loaded(root, [{ name: 'a.ts', type: 'file' }, { name: 'src', type: 'directory' }, { name: 'z.ts', type: 'file' }], false)
    store.actions.loaded(`${root.replace(/[/\\]+$/, '')}/src`, [{ name: 'nested.ts', type: 'file' }], false)
  }
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
    useSessions: selector => selector({ ids: [sessionId], byId: { [sessionId]: { id: sessionId, title: 'test', displayTitle: 'test', running: false, blank: false, updatedAt: 0, ...(root === null ? {} : { cwd: root }), retainedBy: {} } }, phase: 'ready', projectionsBySession: {} }),
    useAgents: selector => selector({}),
    loadDir: vi.fn(),
    search: vi.fn(async () => ({ matches: [{ absolutePath: 'C:/repo/a.ts', path: 'a.ts', line: 1, column: 1, text: 'one' }], truncated: false })),
    openFile: store.actions.opened,
    closeFile: store.actions.closed,
    closeDirs: vi.fn(),
    write: vi.fn(),
    reload: vi.fn(),
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

describe('IdePage Agent titles', () => {
  it('updates every Agent tab from its own Session title, including inactive tabs', () => {
    const secondId = 's-second' as SessionId
    const thirdId = 's-third' as SessionId
    const row = (id: SessionId) => ({ id, displayTitle: 'repo', running: false, blank: false, updatedAt: 0, cwd: 'C:/repo', retainedBy: {} })
    const sessions = createSnapshotStore<SessionListState>({
      ids: [sessionId, secondId, thirdId],
      byId: { [sessionId]: row(sessionId), [secondId]: row(secondId), [thirdId]: row(thirdId) },
      phase: 'ready', projectionsBySession: {},
    })
    const { store } = mount({ useSessions: bindSnapshotSelector(sessions) })
    act(() => { store.actions.agentAdded(secondId); store.actions.agentAdded(thirdId) })
    expect(screen.getByRole('tab', { name: 'Agent 1' })).not.toBeNull()
    expect(screen.getByRole('tab', { name: /^Agent 2/ })).not.toBeNull()
    expect(screen.getByRole('tab', { name: /^Agent 3/ })).not.toBeNull()

    act(() => {
      sessions.update((state) => {
        state.byId[sessionId]!.title = '修复登录'
        state.byId[secondId]!.title = '优化查询'
        state.byId[thirdId]!.title = '补充测试'
      })
    })
    expect(screen.getByRole('tab', { name: '修复登录' })).not.toBeNull()
    expect(screen.getByRole('tab', { name: /^优化查询/ })).not.toBeNull()
    expect(screen.getByRole('tab', { name: /^补充测试/ }).getAttribute('aria-selected')).toBe('true')

    fireEvent.click(screen.getByRole('tab', { name: /^优化查询/ }))
    act(() => { sessions.update((state) => { state.byId[thirdId]!.title = '手动命名的会话' }) })
    expect(screen.getByRole('tab', { name: /^优化查询/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: /^手动命名的会话/ })).not.toBeNull()
    act(() => { store.actions.agentClosed(secondId) })
    expect(screen.queryByRole('tab', { name: /^优化查询/ })).toBeNull()
    expect(screen.getByRole('tab', { name: /^手动命名的会话/ })).not.toBeNull()
  })
})

describe('IdePage file interaction', () => {
  it.each(['click', 'contextMenu'] as const)('opens a creation-only menu on blank tree %s and creates at the root', async (gesture) => {
    const { store, props } = mount()
    act(() => { store.actions.selection(['C:/repo/src'], 'C:/repo/src') })
    const tree = screen.getByRole('tree')
    const accepted = fireEvent[gesture](tree, { button: gesture === 'click' ? 0 : 2, clientX: 36, clientY: 140 })
    if (gesture === 'contextMenu') expect(accepted).toBe(false)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['新建文件', '新建文件夹'])
    expect(props.createEntry).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: '新建文件' }))
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: 'new.ts' } })
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    await waitFor(() => { expect(props.createEntry).toHaveBeenCalledExactlyOnceWith('C:/repo/new.ts', 'file') })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it.each([
    { root: '/', want: '/new-dir' },
    { root: 'C:\\', want: 'C:/new-dir' },
    { root: 'C:\\repo', want: 'C:\\repo/new-dir' },
    { root: '\\\\server\\share\\', want: '\\\\server\\share/new-dir' },
  ])('creates a folder in an empty workspace rooted at $root', async ({ root, want }) => {
    const { store, props } = mount({}, root)
    act(() => { store.actions.loaded(root, [], false) })
    fireEvent.contextMenu(screen.getByRole('tree'), { clientX: 20, clientY: 80 })
    fireEvent.click(screen.getByRole('menuitem', { name: '新建文件夹' }))
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: 'new-dir' } })
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    await waitFor(() => { expect(props.createEntry).toHaveBeenCalledExactlyOnceWith(want, 'directory') })
  })

  it.each([
    { current: undefined, want: 'C:/repo/top.ts' },
    { current: 'src', want: 'C:/repo/src/top.ts' },
    { current: 'a.ts', want: 'C:/repo/top.ts' },
    { current: 'nested.ts', want: 'C:/repo/src/top.ts' },
  ])('uses the current folder or file parent for the header creation menu: $current', async ({ current, want }) => {
    const { props } = mount()
    if (current === 'nested.ts') fireEvent.click(screen.getByRole('treeitem', { name: 'src' }))
    if (current !== undefined) fireEvent.click(screen.getByRole('treeitem', { name: current }))
    fireEvent.click(screen.getByRole('button', { name: '新建文件' }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['新建文件', '新建文件夹'])
    fireEvent.click(screen.getByRole('menuitem', { name: '新建文件' }))
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: 'top.ts' } })
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    await waitFor(() => { expect(props.createEntry).toHaveBeenCalledExactlyOnceWith(want, 'file') })
  })

  it('focuses the first creation item after keyboard opening and activates it from the keyboard', async () => {
    const { props } = mount()
    const trigger = screen.getByRole('button', { name: '新建文件' })
    trigger.focus()
    // Native buttons synthesize a detail-zero click for keyboard activation.
    fireEvent.click(trigger, { detail: 0 })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '新建文件' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
    const input = screen.getByRole('textbox', { name: '名称' })
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'keyboard.ts' } })
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    await waitFor(() => { expect(props.createEntry).toHaveBeenCalledExactlyOnceWith('C:/repo/keyboard.ts', 'file') })
  })

  it('returns focus to the header creation trigger after Escape closes its menu', () => {
    mount()
    const trigger = screen.getByRole('button', { name: '新建文件' })
    trigger.focus()
    fireEvent.click(trigger, { detail: 0 })
    screen.getByRole('menuitem', { name: '新建文件' }).focus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes the creation menu on an outside pointer without stealing focus from that control', () => {
    mount()
    const trigger = screen.getByRole('button', { name: '新建文件' })
    trigger.focus()
    fireEvent.click(trigger, { detail: 0 })
    const outside = screen.getByRole('button', { name: '刷新文件树' })
    outside.focus()
    fireEvent.pointerDown(outside)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(outside)
  })

  it('keeps row selection, folder expansion and row context targets separate from blank-space creation', async () => {
    const { store, props } = mount()
    const folder = screen.getByRole('treeitem', { name: 'src' })
    fireEvent.click(folder.querySelector('svg')!)
    expect(store.getSnapshot().expanded).toContain('C:/repo/src')
    expect(store.getSnapshot().selected).toEqual(['C:/repo/src'])
    expect(screen.queryByRole('menu')).toBeNull()
    const nested = screen.getByRole('treeitem', { name: 'nested.ts' })
    fireEvent.click(nested.querySelector('span')!)
    expect(store.getSnapshot().active).toBe('C:/repo/src/nested.ts')
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(nested.querySelector('svg')!, { clientX: 40, clientY: 120 })
    expect(screen.getByRole('menuitem', { name: '重命名' })).not.toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: '新建文件夹' }))
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: 'sibling' } })
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    await waitFor(() => { expect(props.createEntry).toHaveBeenCalledExactlyOnceWith('C:/repo/src/sibling', 'directory') })
  })

  it('does not open a creation menu from Retry or without a workspace', () => {
    const { store, props } = mount()
    act(() => { store.actions.failed('C:/repo', new RemoteError('workspace-file/not-found', 'missing', { path: 'C:/repo' })) })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(props.loadDir).toHaveBeenLastCalledWith('C:/repo')
    expect(screen.queryByRole('menu')).toBeNull()
    cleanup()
    mount({}, null)
    expect(screen.queryByRole('tree')).toBeNull()
    const create = screen.queryByRole<HTMLButtonElement>('button', { name: '新建文件' })
    expect(create === null || create.disabled).toBe(true)
    fireEvent.contextMenu(screen.getByRole('region', { name: '文件' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('cancels blank-space creation and retains name validation without creating entries', () => {
    const { props } = mount()
    const tree = screen.getByRole('tree')
    fireEvent.click(tree)
    fireEvent.keyDown(screen.getByRole('menuitem', { name: '新建文件' }), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(tree)
    fireEvent.click(screen.getByRole('menuitem', { name: '新建文件' }))
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '../bad' } })
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(screen.getByRole('alert').textContent).toBe(zh.invalidName)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('textbox', { name: '名称' })).toBeNull()
    expect(props.createEntry).not.toHaveBeenCalled()
  })

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
      store.actions.fileRead({ path: 'C:/repo/a.ts', name: 'a.ts', status: 'ready', baseline: 'one', disk: 'one', draft: 'one', version: '1', diskVersion: '1', finalNewline: false, saving: false })
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

  it('saves against the version the draft derives from, and settles a disk conflict through its two choices', () => {
    const { store, props } = mount()
    act(() => {
      store.actions.opened('C:/repo/a.ts', 'a.ts')
      store.actions.fileRead({ path: 'C:/repo/a.ts', name: 'a.ts', status: 'ready', baseline: 'one', disk: 'one', draft: 'one', version: '1', diskVersion: '1', finalNewline: false, saving: false })
      store.actions.edited('C:/repo/a.ts', 'mine')
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(props.write).toHaveBeenLastCalledWith('C:/repo/a.ts', 'mine', '1', 'one')

    act(() => { store.actions.disk('C:/repo/a.ts', 'theirs', '2', false) })
    expect(screen.getByRole('alert').textContent).toBe('磁盘上的文件已被修改，而你有未保存的改动。')
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保留我的改动并覆盖' }))
    expect(props.write).toHaveBeenLastCalledWith('C:/repo/a.ts', 'mine', '2', 'theirs')
    fireEvent.click(screen.getByRole('button', { name: '改用磁盘内容' }))
    expect(store.getSnapshot().files['C:/repo/a.ts']).toMatchObject({ draft: 'theirs', version: '2' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    'workspace-file/not-text', 'workspace-file/too-large', 'workspace-file/not-found', 'gateway/internal', 'client/read-failed',
  ])('shows the actual %s failure instead of guessing the file type or size', (code) => {
    const { store, props } = mount()
    act(() => {
      store.actions.opened('C:/repo/a.ts', 'a.ts')
      store.actions.fileFailed('C:/repo/a.ts', { code, message: 'Read operation refused' })
    })
    expect(screen.getByRole('alert').textContent).toBe('无法打开该文件（' + code + '）：Read operation refused')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(props.reload).toHaveBeenCalledWith('C:/repo/a.ts')
  })

  it('keeps the editor and offers a retry when an open file cannot be reread', () => {
    const { store, props } = mount()
    act(() => {
      store.actions.opened('C:/repo/a.ts', 'a.ts')
      store.actions.fileRead({ path: 'C:/repo/a.ts', name: 'a.ts', status: 'ready', baseline: 'one', disk: 'one', draft: 'one', version: '1', diskVersion: '1', finalNewline: false, saving: false })
      store.actions.fileFailed('C:/repo/a.ts')
    })
    expect(screen.getByRole('textbox', { name: 'editor C:/repo/a.ts' })).not.toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('无法重新读取磁盘上的文件，显示的是上次读到的内容。')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(props.reload).toHaveBeenCalledWith('C:/repo/a.ts')
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
