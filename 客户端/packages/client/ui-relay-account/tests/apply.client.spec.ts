// @vitest-environment jsdom
/** The relay plugin follows the signed-in account of its state stream and shows the operator's announcement on the frame overlay. */
import type { RelayAnnouncement, RelayAnnouncementResult, RelayView, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apply, inject, type RelayAnnouncementInjected } from '../src/client/index.ts'
import { RelayAnnouncementBanner } from '../src/client/RelayAnnouncementBanner.tsx'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

const notice: RelayAnnouncement = { title: '公告', content: '已经上架新模型', level: 'error' }
const signedOut: RelayView = {
  account: { status: 'signed-out', profile: null, expiresAt: null, upload: { phase: 'idle', sent: 0, total: 0 }, signIn: { phase: 'idle' }, hasBackground: false },
  license: null, configured: true,
}
const signedIn: RelayView = {
  ...signedOut, account: { ...signedOut.account, status: 'signed-in', profile: { id: 7, email: 'a@b.co', avatarUrl: null }, expiresAt: '2030-01-01T00:00:00Z' },
}

interface Registered {
  readonly name: string
  readonly id?: string
  readonly locale?: string
  readonly inject?: () => object
  readonly component: unknown
}

/** Run the plugin against scripted slots, locale and Remote faces; `push` delivers one relay snapshot. */
function plugin() {
  const disposers: (() => unknown)[] = []
  const registered: Registered[] = []
  const frames: RelayView[] = []
  let wake: (() => void) | undefined
  let closed = false
  const announcement = vi.fn((): Promise<RemoteResult<RelayAnnouncementResult>> => Promise.resolve({ ok: true, value: { ok: true, announcement: notice } }))
  const ctx = {
    effect: (install: () => (() => unknown) | undefined) => {
      const dispose = install()
      if (dispose !== undefined) disposers.push(dispose)
    },
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    slots: {
      inject: (_name: string, install: () => unknown) => { install() },
      register: (entry: Omit<Registered, 'component'>, component: unknown) => {
        registered.push({ ...entry, component })
        return () => {}
      },
    },
    remote: {
      relay: { watch: vi.fn(), announcement },
      $stream: () => ({
        dispose: () => { closed = true; wake?.(); return Promise.resolve() },
        async *[Symbol.asyncIterator]() {
          while (!closed) {
            const value = frames.shift()
            if (value !== undefined) { yield { value, accept: () => {} }; continue }
            await new Promise<void>((resolve) => { wake = resolve })
          }
        },
      }),
    },
  }
  // The plugin reads only the members scripted above of the Client context.
  apply(ctx as never)
  return {
    announcement, registered,
    push: async (view: RelayView) => { frames.push(view); wake?.(); await vi.advanceTimersByTimeAsync(0) },
    dispose: async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() },
  }
}

it('registers the announcement banner on the frame overlay and checks only for a signed-in account', async () => {
  expect(inject).toContain('remote.relay')
  const p = plugin()
  try {
    const overlay = p.registered.filter(entry => entry.name === 'shell.overlay')
    expect(overlay).toHaveLength(1)
    expect(overlay[0]).toMatchObject({ id: 'relay-account.announcement', locale: 'settings.relay-account', component: RelayAnnouncementBanner })
    const face = overlay[0]!.inject!() as RelayAnnouncementInjected
    const shown = (): RelayAnnouncement | null => face.hooks.announcement.getSnapshot()

    await p.push(signedOut)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(p.announcement).not.toHaveBeenCalled()
    expect(shown()).toBeNull()

    await p.push(signedIn)
    expect(p.announcement).toHaveBeenCalledTimes(1)
    expect(shown()).toEqual(notice)
    await p.push(signedIn)
    expect(p.announcement).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(p.announcement).toHaveBeenCalledTimes(2)

    // A dropped Host call is a failed check: the banner stays and the next check still happens.
    p.announcement.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'Unavailable', {}) })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(shown()).toEqual(notice)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(p.announcement).toHaveBeenCalledTimes(4)

    face.dismiss()
    expect(shown()).toBeNull()
    expect(localStorage.length).toBe(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(shown()).toBeNull()

    p.announcement.mockResolvedValue({ ok: true, value: { ok: true, announcement: { ...notice, content: '今晚维护' } } })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(shown()?.content).toBe('今晚维护')

    await p.push(signedOut)
    expect(shown()).toBeNull()
    const calls = p.announcement.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(p.announcement).toHaveBeenCalledTimes(calls)
  } finally {
    await p.dispose()
  }
})

it('stops checking when the plugin is disposed', async () => {
  const p = plugin()
  await p.push(signedIn)
  expect(p.announcement).toHaveBeenCalledTimes(1)
  await p.dispose()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(p.announcement).toHaveBeenCalledTimes(1)
})
