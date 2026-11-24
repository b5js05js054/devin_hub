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
  store.actions.fileRead({ path, name: 'a.ts', status: 'ready', baseline: text, disk: text, draft: text, version: 'v1', diskVersion: 'v1', finalNewline: true, saving: false })
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

  it('follows disk changes into an untouched draft', () => {
    const store = opened()
    store.actions.disk('/w/a.ts', 'two', 'v2', true)
    expect(store.store.getSnapshot().files['/w/a.ts']).toMatchObject({ disk: 'two', draft: 'two', version: 'v2', diskVersion: 'v2', baseline: 'one' })
  })

  it('flags a conflict and keeps the save version behind when the disk changes under unsaved edits', () => {
    const store = opened()
    store.actions.edited('/w/a.ts', 'mine')
    store.actions.disk('/w/a.ts', 'theirs', 'v2', true)
    expect(store.store.getSnapshot().files['/w/a.ts']).toMatchObject({ disk: 'theirs', draft: 'mine', version: 'v1', diskVersion: 'v2', error: 'stale' })
    // Another reread of the same text does not make the draft current.
    store.actions.disk('/w/a.ts', 'theirs', 'v3', true)
    expect(store.store.getSnapshot().files['/w/a.ts']).toMatchObject({ version: 'v1', diskVersion: 'v3', error: 'stale' })
  })

  it('moves the save version along when only the version changed under unsaved edits', () => {
    const store = opened()
    store.actions.edited('/w/a.ts', 'mine')
    store.actions.saving('/w/a.ts', false, 'save')
    store.actions.disk('/w/a.ts', 'one', 'v2', true)
    const file = store.store.getSnapshot().files['/w/a.ts']
    expect(file).toMatchObject({ draft: 'mine', version: 'v2', diskVersion: 'v2' })
    expect(file?.error).toBeUndefined()
  })

  it('settles a conflict by taking the disk text, by typing it, or when the disk catches up with the draft', () => {
    const conflicted = () => {
      const store = opened()
      store.actions.edited('/w/a.ts', 'mine')
      store.actions.disk('/w/a.ts', 'theirs', 'v2', true)
      return store
    }
    const taken = conflicted()
    taken.actions.draftReset('/w/a.ts')
    expect(taken.store.getSnapshot().files['/w/a.ts']).toMatchObject({ draft: 'theirs', version: 'v2' })
    expect(taken.store.getSnapshot().files['/w/a.ts']?.error).toBeUndefined()
    const typed = conflicted()
    typed.actions.edited('/w/a.ts', 'theirs')
    expect(typed.store.getSnapshot().files['/w/a.ts']).toMatchObject({ version: 'v2' })
    expect(typed.store.getSnapshot().files['/w/a.ts']?.error).toBeUndefined()
    const caughtUp = conflicted()
    caughtUp.actions.disk('/w/a.ts', 'mine', 'v3', true)
    expect(caughtUp.store.getSnapshot().files['/w/a.ts']).toMatchObject({ draft: 'mine', version: 'v3' })
    expect(caughtUp.store.getSnapshot().files['/w/a.ts']?.error).toBeUndefined()
  })

  it('takes the user\'s own save into the baseline and leaves a later draft unsaved', () => {
    const store = opened()
    store.actions.edited('/w/a.ts', 'mine')
    store.actions.saving('/w/a.ts', true)
    store.actions.edited('/w/a.ts', 'mine and more')
    store.actions.saved('/w/a.ts', 'mine', 'v2', 'one')
    expect(store.store.getSnapshot().files['/w/a.ts']).toMatchObject({
      baseline: 'mine', disk: 'mine', draft: 'mine and more', version: 'v2', diskVersion: 'v2', saving: false,
    })
  })

  it('reaches the same state when the reread of a save arrives before the save result', () => {
    const store = opened()
    store.actions.edited('/w/a.ts', 'mine')
    store.actions.saving('/w/a.ts', true)
    store.actions.edited('/w/a.ts', 'mine and more')
    store.actions.disk('/w/a.ts', 'mine', 'v2', true)
    expect(store.store.getSnapshot().files['/w/a.ts']?.error).toBeUndefined()
    store.actions.saved('/w/a.ts', 'mine', 'v2', 'one')
    const file = store.store.getSnapshot().files['/w/a.ts']
    expect(file).toMatchObject({ baseline: 'mine', disk: 'mine', draft: 'mine and more', version: 'v2', diskVersion: 'v2', saving: false })
    expect(file?.error).toBeUndefined()
  })

  it('keeps an untouched Agent block pending across the user\'s own save', () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
    const baseline = lines.join('\n')
    const agent = baseline.replace('line 3', 'AGENT 3')
    const store = opened('/w/a.ts', baseline)
    store.actions.disk('/w/a.ts', agent, 'v2', true)
    const mine = agent.replace('line 25', 'MINE 25')
    store.actions.edited('/w/a.ts', mine)
    store.actions.saved('/w/a.ts', mine, 'v3', agent)
    expect(store.store.getSnapshot().files['/w/a.ts']).toMatchObject({ baseline: baseline.replace('line 25', 'MINE 25'), disk: mine, draft: mine })
  })

  it('lets a clean draft follow a review write and keeps the baseline', () => {
    const store = opened()
    store.actions.disk('/w/a.ts', 'agent', 'v2', true)
    store.actions.saved('/w/a.ts', 'one', 'v3', undefined)
    expect(store.store.getSnapshot().files['/w/a.ts']).toMatchObject({ baseline: 'one', disk: 'one', draft: 'one', version: 'v3' })
  })

  it('keeps an opened file on screen when a reread fails, and fails a file that was never read', () => {
    const store = opened()
    store.actions.edited('/w/a.ts', 'mine')
    store.actions.fileFailed('/w/a.ts')
    expect(store.store.getSnapshot().files['/w/a.ts']).toMatchObject({ status: 'ready', draft: 'mine', error: 'read' })
    store.actions.opened('/w/b.ts', 'b.ts')
    store.actions.fileFailed('/w/b.ts')
    expect(store.store.getSnapshot().files['/w/b.ts']).toMatchObject({ status: 'failed', error: 'read' })
  })

  it('ignores a file read that arrives after its tab closed', () => {
    const store = createIdeStore().create()
    store.actions.fileRead({ path: '/w/gone.ts', name: 'gone.ts', status: 'ready', baseline: '', disk: '', draft: '', version: 'v1', diskVersion: 'v1', finalNewline: false, saving: false })
    expect(store.store.getSnapshot().files).toEqual({})
  })
})
