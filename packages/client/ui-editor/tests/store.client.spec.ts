import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdeStore } from '../src/client/store.ts'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  })
})

function opened(path = '/w/a.ts', text = 'one') {
  const store = createIdeStore().create()
  store.actions.opened(path, 'a.ts')
  store.actions.fileRead({ path, name: 'a.ts', status: 'ready', baseline: text, disk: text, draft: text, version: 'v1', finalNewline: true, saving: false })
  return store
}

describe('createIdeStore', () => {
  it('starts with the terminal closed and the default layout', () => {
    const state = createIdeStore().create().store.getSnapshot()
    expect(state).toMatchObject({ filesCollapsed: false, agentCollapsed: false, terminalOpen: false, terminalHeight: 240 })
  })

  it('patches only the layout fields it is given', () => {
    const store = createIdeStore().create()
    store.actions.layout({ terminalOpen: true, terminalHeight: 300 })
    expect(store.store.getSnapshot()).toMatchObject({ terminalOpen: true, terminalHeight: 300, filesWidth: 260, agentWidth: 420 })
  })

  it('persists the panel layout and falls back for corrupt storage', () => {
    const store = createIdeStore().create()
    store.actions.layout({ filesCollapsed: true, filesWidth: 300, agentWidth: 500 })
    expect(createIdeStore().create().store.getSnapshot()).toMatchObject({ filesCollapsed: true, filesWidth: 300, agentWidth: 500 })
    localStorage.setItem('dsh.ide.layout', '{broken')
    expect(createIdeStore().create().store.getSnapshot()).toMatchObject({ filesCollapsed: false, filesWidth: 260, agentWidth: 420 })
  })

  it('activates the next tab when the active one closes', () => {
    const store = createIdeStore().create()
    store.actions.opened('/w/a.ts', 'a.ts')
    store.actions.opened('/w/b.ts', 'b.ts')
    store.actions.closed('/w/b.ts')
    const state = store.store.getSnapshot()
    expect(state.tabs).toEqual(['/w/a.ts'])
    expect(state.active).toBe('/w/a.ts')
    expect(state.files['/w/b.ts']).toBeUndefined()
  })

  it('follows disk changes into an untouched draft but keeps unsaved edits', () => {
    const store = opened()
    store.actions.disk('/w/a.ts', 'two', 'v2', true)
    expect(store.store.getSnapshot().files['/w/a.ts']).toMatchObject({ disk: 'two', draft: 'two', version: 'v2', baseline: 'one' })
    store.actions.edited('/w/a.ts', 'mine')
    store.actions.disk('/w/a.ts', 'three', 'v3', true)
    expect(store.store.getSnapshot().files['/w/a.ts']).toMatchObject({ disk: 'three', draft: 'mine', version: 'v3' })
  })

  it('keeps a stale conflict while the draft is unsaved and clears it once the draft is clean', () => {
    const store = opened()
    store.actions.edited('/w/a.ts', 'mine')
    store.actions.saving('/w/a.ts', false, 'stale')
    store.actions.disk('/w/a.ts', 'other', 'v2', true)
    expect(store.store.getSnapshot().files['/w/a.ts']?.error).toBe('stale')
    store.actions.edited('/w/a.ts', 'other')
    store.actions.disk('/w/a.ts', 'other', 'v3', true)
    expect(store.store.getSnapshot().files['/w/a.ts']?.error).toBeUndefined()
  })

  it('ignores a file read that arrives after its tab closed', () => {
    const store = createIdeStore().create()
    store.actions.fileRead({ path: '/w/gone.ts', name: 'gone.ts', status: 'ready', baseline: '', disk: '', draft: '', version: 'v1', finalNewline: false, saving: false })
    expect(store.store.getSnapshot().files).toEqual({})
  })
})
