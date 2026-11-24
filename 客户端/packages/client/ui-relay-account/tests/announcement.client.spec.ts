/** Relay announcement watcher: five-second checks gated by sign-in and page visibility, and remembered dismissal. */
import type { RelayAnnouncement, RelayAnnouncementResult, RelayView } from '@deepseek-ai/dsh-api-remotes/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ANNOUNCEMENT_INTERVAL_MS, announcementSession, createAnnouncementWatcher } from '../src/client/announcement.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const notice: RelayAnnouncement = { title: '公告', content: '已经上架新模型', level: 'error' }
const published = (announcement: RelayAnnouncement | null): RelayAnnouncementResult => ({ ok: true, announcement })
/** Let settled promises and due timers run without moving the clock. */
const settle = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0)

function fixture(initial: { visible?: boolean, dismissed?: string | null } = {}) {
  let visible = initial.visible ?? true
  let remembered = initial.dismissed ?? null
  const watching = new Set<() => void>()
  const load = vi.fn((): Promise<RelayAnnouncementResult> => Promise.resolve(published(notice)))
  const write = vi.fn((signature: string | null) => { remembered = signature })
  const watcher = createAnnouncementWatcher({
    load,
    memory: { read: () => remembered, write },
    visibility: {
      visible: () => visible,
      subscribe: (listener) => { watching.add(listener); return () => { watching.delete(listener) } },
    },
  })
  const changed = vi.fn()
  watcher.hooks.announcement.subscribe(changed)
  return {
    watcher, load, write, changed, watching,
    shown: () => watcher.hooks.announcement.getSnapshot(),
    remembered: () => remembered,
    show: (next: boolean) => { visible = next; for (const listener of [...watching]) listener() },
  }
}

it('checks at once when a session appears and then every five seconds', async () => {
  const f = fixture()
  expect(ANNOUNCEMENT_INTERVAL_MS).toBe(5_000)
  f.watcher.follow('7|2030-01-01')
  await settle()
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(f.shown()).toEqual(notice)
  await vi.advanceTimersByTimeAsync(4_999)
  expect(f.load).toHaveBeenCalledTimes(1)
  const edited: RelayAnnouncement = { ...notice, content: '今晚维护' }
  f.load.mockResolvedValue(published(edited))
  await vi.advanceTimersByTimeAsync(1)
  expect(f.load).toHaveBeenCalledTimes(2)
  expect(f.shown()).toEqual(edited)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.load).toHaveBeenCalledTimes(3)
})

it('hides the announcement on the first check after the operator withdraws it', async () => {
  const f = fixture()
  f.watcher.follow('7|2030-01-01')
  await settle()
  f.load.mockResolvedValue(published(null))
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.shown()).toBeNull()
})

it('tells subscribers only when the shown announcement changes', async () => {
  const f = fixture()
  f.watcher.follow('7|2030-01-01')
  await vi.advanceTimersByTimeAsync(20_000)
  expect(f.load).toHaveBeenCalledTimes(5)
  expect(f.changed).toHaveBeenCalledTimes(1)
  const first = f.shown()
  f.load.mockResolvedValue(published({ ...notice }))
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.shown()).toBe(first)
  const late = vi.fn()
  f.watcher.hooks.announcement.subscribe(late)()
  f.load.mockResolvedValue(published(null))
  await vi.advanceTimersByTimeAsync(5_000)
  expect(late).not.toHaveBeenCalled()
  expect(f.changed).toHaveBeenCalledTimes(2)
})

it('asks nothing while signed out and hides the announcement at sign-out', async () => {
  const f = fixture()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.load).not.toHaveBeenCalled()
  f.watcher.follow('7|2030-01-01')
  await settle()
  expect(f.shown()).toEqual(notice)
  f.watcher.follow(undefined)
  expect(f.shown()).toBeNull()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.load).toHaveBeenCalledTimes(1)
})

it('follows one session once, however often the same one is reported', async () => {
  const f = fixture()
  f.watcher.follow('7|2030-01-01')
  await settle()
  f.watcher.follow('7|2030-01-01')
  await settle()
  expect(f.load).toHaveBeenCalledTimes(1)
})

it('keeps the announcement through a failed check and asks again', async () => {
  const f = fixture()
  f.watcher.follow('7|2030-01-01')
  await settle()
  f.load.mockResolvedValueOnce({ ok: false, code: 'network', message: 'offline' })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.shown()).toEqual(notice)
  f.load.mockRejectedValueOnce(new Error('Host connection closed'))
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.shown()).toEqual(notice)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.load).toHaveBeenCalledTimes(4)
})

it.each(['signed-out', 'unauthorized'] as const)('stops asking once the Host reports the session %s, until another session signs in', async (code) => {
  const f = fixture()
  f.watcher.follow('7|2030-01-01')
  await settle()
  f.load.mockResolvedValueOnce({ ok: false, code, message: '' })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.shown()).toBeNull()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.load).toHaveBeenCalledTimes(2)
  f.show(false)
  f.show(true)
  await settle()
  expect(f.load).toHaveBeenCalledTimes(2)
  f.watcher.follow('7|2031-01-01')
  await settle()
  expect(f.load).toHaveBeenCalledTimes(3)
  expect(f.shown()).toEqual(notice)
})

it('never overlaps checks: the pause begins when an answer arrives', async () => {
  const f = fixture()
  let answer: (result: RelayAnnouncementResult) => void = () => undefined
  f.load.mockImplementationOnce(() => new Promise<RelayAnnouncementResult>((resolve) => { answer = resolve }))
  f.watcher.follow('7|2030-01-01')
  await vi.advanceTimersByTimeAsync(20_000)
  f.show(true)
  await settle()
  expect(f.load).toHaveBeenCalledTimes(1)
  answer(published(notice))
  await vi.advanceTimersByTimeAsync(4_999)
  expect(f.load).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.load).toHaveBeenCalledTimes(2)
})

it('drops the answer of a check that began before sign-out', async () => {
  const f = fixture()
  let answer: (result: RelayAnnouncementResult) => void = () => undefined
  f.load.mockImplementationOnce(() => new Promise<RelayAnnouncementResult>((resolve) => { answer = resolve }))
  f.watcher.follow('7|2030-01-01')
  await settle()
  f.watcher.follow(undefined)
  answer(published(notice))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.shown()).toBeNull()
  expect(f.load).toHaveBeenCalledTimes(1)
})

it('asks again at once when the session changed during a check', async () => {
  const f = fixture()
  let answer: (result: RelayAnnouncementResult) => void = () => undefined
  f.load.mockImplementationOnce(() => new Promise<RelayAnnouncementResult>((resolve) => { answer = resolve }))
  f.watcher.follow('7|2030-01-01')
  await settle()
  f.watcher.follow('8|2030-01-01')
  await settle()
  expect(f.load).toHaveBeenCalledTimes(1)
  f.load.mockResolvedValue(published({ ...notice, title: '第二个账号' }))
  answer({ ok: false, code: 'unauthorized', message: '' })
  await settle()
  expect(f.load).toHaveBeenCalledTimes(2)
  expect(f.shown()?.title).toBe('第二个账号')
})

it('pauses while the page is hidden and checks at once when it shows again', async () => {
  const f = fixture({ visible: false })
  f.watcher.follow('7|2030-01-01')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.load).not.toHaveBeenCalled()
  f.show(true)
  await settle()
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(f.shown()).toEqual(notice)
  await vi.advanceTimersByTimeAsync(2_000)
  f.show(false)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(f.shown()).toEqual(notice)
  f.show(true)
  await settle()
  expect(f.load).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.load).toHaveBeenCalledTimes(3)
})

it('keeps a dismissed announcement hidden, shows an edited one, and forgets the dismissal once it is withdrawn', async () => {
  const f = fixture()
  f.watcher.dismiss()
  expect(f.write).not.toHaveBeenCalled()
  f.watcher.follow('7|2030-01-01')
  await settle()
  f.watcher.dismiss()
  expect(f.shown()).toBeNull()
  expect(f.remembered()).not.toBeNull()
  await vi.advanceTimersByTimeAsync(15_000)
  expect(f.shown()).toBeNull()
  const edited: RelayAnnouncement = { ...notice, level: 'warning' }
  f.load.mockResolvedValue(published(edited))
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.shown()).toEqual(edited)
  f.watcher.dismiss()
  f.load.mockResolvedValue(published(null))
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.remembered()).toBeNull()
  f.load.mockResolvedValue(published(edited))
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.shown()).toEqual(edited)
})

it('remembers a dismissal across restarts', async () => {
  const before = fixture()
  before.watcher.follow('7|2030-01-01')
  await settle()
  before.watcher.dismiss()
  const after = fixture({ dismissed: before.remembered() })
  after.watcher.follow('7|2030-01-01')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(after.load).toHaveBeenCalledTimes(3)
  expect(after.shown()).toBeNull()
  expect(after.write).not.toHaveBeenCalled()
})

it('stops for good once disposed', async () => {
  const f = fixture()
  let answer: (result: RelayAnnouncementResult) => void = () => undefined
  f.watcher.follow('7|2030-01-01')
  await settle()
  f.load.mockImplementationOnce(() => new Promise<RelayAnnouncementResult>((resolve) => { answer = resolve }))
  await vi.advanceTimersByTimeAsync(5_000)
  f.watcher.dispose()
  expect(f.watching.size).toBe(0)
  answer(published(null))
  f.watcher.follow('8|2030-01-01')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.load).toHaveBeenCalledTimes(2)
  expect(f.shown()).toEqual(notice)
})

it('names a signed-in session by its account and expiry, and no session otherwise', () => {
  const account: RelayView['account'] = {
    status: 'signed-out', profile: null, expiresAt: null, upload: { phase: 'idle', sent: 0, total: 0 }, signIn: { phase: 'idle' }, hasBackground: false,
  }
  expect(announcementSession(undefined)).toBeUndefined()
  expect(announcementSession({ account, license: null, configured: true })).toBeUndefined()
  const signedIn: RelayView = {
    account: { ...account, status: 'signed-in', profile: { id: 7, email: 'a@b.co', avatarUrl: null }, expiresAt: '2030-01-01T00:00:00Z' }, license: null, configured: true,
  }
  expect(announcementSession(signedIn)).toBe('7|2030-01-01T00:00:00Z')
  expect(announcementSession({ ...signedIn, account: { ...signedIn.account, profile: { id: 8, email: 'b@b.co', avatarUrl: null } } })).toBe('8|2030-01-01T00:00:00Z')
  expect(announcementSession({ ...signedIn, account: { ...signedIn.account, profile: null } })).toBeUndefined()
})
