// @vitest-environment jsdom
/** Relay announcement banner, and the page bindings its watcher runs on. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RelayAnnouncement } from '@deepseek-ai/dsh-api-remotes/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RelayAnnouncementBanner, type RelayAnnouncementBannerProps } from '../src/client/RelayAnnouncementBanner.tsx'
import { pageVisibility, rememberedDismissal } from '../src/client/announcement.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})

const dictionary = new Map(Object.entries(en))
const t = (key: string): string => dictionary.get(key) ?? key

function mount(announcement: RelayAnnouncement | null) {
  const dismiss = vi.fn()
  const props = {
    t, dismiss, useAnnouncement: <U,>(select: (value: RelayAnnouncement | null) => U): U => select(announcement),
  } as RelayAnnouncementBannerProps
  render(<RelayAnnouncementBanner {...props} />)
  return dismiss
}

it('renders nothing while no announcement is published', () => {
  mount(null)
  expect(screen.queryByRole('status')).toBeNull()
})

it('shows the title, every line of the content, and the level the operator chose', () => {
  mount({ title: '维护通知', content: '今晚 23:00 维护\n预计 30 分钟', level: 'error' })
  const banner = screen.getByRole('status', { name: en.announcement })
  expect(banner.getAttribute('data-level')).toBe('error')
  expect(screen.getByText('维护通知')).toBeTruthy()
  expect(banner.querySelector('p')?.textContent).toBe('今晚 23:00 维护\n预计 30 分钟')
})

it('titles an announcement that came without a title', () => {
  mount({ title: '', content: '已经上架新模型', level: 'info' })
  expect(screen.getByRole('status').querySelector('strong')?.textContent).toBe(en.announcement)
})

it('dismisses the announcement from its close button', () => {
  const dismiss = mount({ title: '公告', content: '已经上架新模型', level: 'success' })
  fireEvent.click(screen.getByRole('button', { name: en.announcementClose }))
  expect(dismiss).toHaveBeenCalledOnce()
})

it('reads the page visibility and reports each change until unsubscribed', () => {
  const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const visibility = pageVisibility()
  expect(visibility.visible()).toBe(false)
  const changed = vi.fn()
  const stop = visibility.subscribe(changed)
  state.mockReturnValue('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  expect(visibility.visible()).toBe(true)
  expect(changed).toHaveBeenCalledOnce()
  stop()
  document.dispatchEvent(new Event('visibilitychange'))
  expect(changed).toHaveBeenCalledOnce()
})

it('keeps the dismissed announcement in the browser store, and forgets it on request', () => {
  const memory = rememberedDismissal()
  expect(memory.read()).toBeNull()
  memory.write('error\n公告\n已经上架新模型')
  expect(rememberedDismissal().read()).toBe('error\n公告\n已经上架新模型')
  memory.write(null)
  expect(rememberedDismissal().read()).toBeNull()
})

it('works without the dismissal memory when the browser store is unavailable', () => {
  const memory = rememberedDismissal()
  memory.write('kept')
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage denied') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage full') })
  expect(memory.read()).toBeNull()
  expect(() => { memory.write('lost') }).not.toThrow()
})
