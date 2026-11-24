// @vitest-environment jsdom
/** Media parameter panel: appears only for media models, applies defaults, and reports every change. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MediaParamsPanel, type MediaParamsInjected } from '../src/client/MediaParamsPanel.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const video = {
  ok: true as const,
  spec: {
    kind: 'video' as const, source: 'builtin' as const,
    fields: [
      { key: 'seconds', label: 'Seconds', type: 'number' as const, min: 1, max: 30, default: 5, required: false },
      { key: 'resolution', label: 'Resolution', type: 'select' as const, options: ['720p', '1080p'], default: '720p', required: false },
    ],
  },
}

async function mount(model: string | undefined, getSpec: MediaParamsInjected['getSpec']) {
  const setParams = vi.fn(async () => {})
  const props = {
    t: (key: keyof typeof en) => en[key],
    useDirectory: (select: (state: { current: { model: string } | undefined }) => unknown) =>
      select({ current: model === undefined ? undefined : { model } }),
    getSpec, setParams,
  }
  await act(async () => { render(<MediaParamsPanel {...(props as unknown as ComponentProps<typeof MediaParamsPanel>)} />) })
  return setParams
}

it('renders nothing for a chat model', async () => {
  await mount('gpt-4', vi.fn(async () => ({ ok: false as const, code: 'not-media' as const, message: '' })))
  expect(screen.queryByRole('button')).toBeNull()
})

it('sends defaults on load and every later change, and flags unconfirmed options', async () => {
  const setParams = await mount('sora', vi.fn(async () => video))
  expect(setParams).toHaveBeenCalledWith('sora', { seconds: 5, resolution: '720p' })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.open })) })
  expect(screen.getByText(en.unconfirmed)).toBeTruthy()
  await act(async () => { fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '1080p' } }) })
  expect(setParams).toHaveBeenLastCalledWith('sora', { seconds: 5, resolution: '1080p' })
  await act(async () => { fireEvent.change(screen.getByLabelText('Seconds'), { target: { value: '12' } }) })
  expect(setParams).toHaveBeenLastCalledWith('sora', { seconds: 12, resolution: '1080p' })
})

it('offers a retry when the lookup fails', async () => {
  const getSpec = vi.fn()
    .mockResolvedValueOnce({ ok: false, code: 'unavailable', message: 'HTTP 500' })
    .mockResolvedValueOnce(video)
  await mount('sora', getSpec)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.open })) })
  expect(screen.getByRole('alert').textContent).toBe(en.loadFailed)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.retry })) })
  expect(getSpec).toHaveBeenCalledTimes(2)
  expect(screen.getByLabelText('Seconds')).toBeTruthy()
})

it('keeps both dictionaries in sync', () => {
  expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
})
