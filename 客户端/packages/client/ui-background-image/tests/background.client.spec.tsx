// @vitest-environment jsdom
/** Background image: controller persistence and page effects, and the settings section. */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { BACKGROUND_ATTRIBUTE, BackgroundController, DEFAULT_OPACITY, clampOpacity, type BackgroundSnapshot, type BackgroundStorage } from '../src/client/controller.ts'
import { BackgroundSection } from '../src/client/BackgroundSection.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

type Saved = { image?: Blob; opacity?: number }

function memoryStorage(initial: Saved = {}): BackgroundStorage & { state: Saved } {
  const state: Saved = { ...initial }
  return {
    state,
    loadImage: async () => state.image,
    saveImage: async (image) => { state.image = image },
    clearImage: async () => { delete state.image },
    loadOpacity: async () => state.opacity,
    saveOpacity: async (percent) => { state.opacity = percent },
  }
}

function makeController(storage: BackgroundStorage) {
  const styles = new Map<string, string>()
  const attributes = new Set<string>()
  const target = {
    setAttribute: (name: string) => { attributes.add(name) },
    removeAttribute: (name: string) => { attributes.delete(name) },
    style: {
      setProperty: (name: string, value: string) => { styles.set(name, value) },
      removeProperty: (name: string) => { styles.delete(name) },
    },
  }
  let counter = 0
  const revoked: string[] = []
  const controller = new BackgroundController({
    storage, target, prepare: async file => file, createObjectUrl: () => `blob:img-${++counter}`, revokeObjectUrl: (url) => { revoked.push(url) },
  })
  return { controller, styles, attributes, revoked }
}

const png = (size = 10) => new File([new Uint8Array(size)], 'a.png', { type: 'image/png' })

it('restores a saved image and opacity onto the page', async () => {
  const { controller, styles, attributes } = makeController(memoryStorage({ image: png(), opacity: 55 }))
  await controller.restore()
  expect(attributes.has(BACKGROUND_ATTRIBUTE)).toBe(true)
  expect(styles.get('--dsh-bg-image')).toBe('url("blob:img-1")')
  expect(styles.get('--dsh-bg-panel')).toBe('55%')
  expect(controller.getSnapshot()).toMatchObject({ hasImage: true, opacity: 55 })
})

it('keeps the default look when nothing is saved', async () => {
  const { controller, attributes } = makeController(memoryStorage())
  await controller.restore()
  expect(attributes.size).toBe(0)
  expect(controller.getSnapshot()).toEqual({ hasImage: false, previewUrl: undefined, opacity: DEFAULT_OPACITY })
})

it('stores a chosen image locally, replaces it, and clears it while releasing old URLs', async () => {
  const storage = memoryStorage()
  const { controller, attributes, revoked } = makeController(storage)
  expect(await controller.choose(png())).toEqual({ ok: true })
  expect(storage.state.image).toBeInstanceOf(Blob)
  await controller.choose(png(20))
  expect(revoked).toEqual(['blob:img-1'])
  await controller.clear()
  expect(storage.state.image).toBeUndefined()
  expect(attributes.has(BACKGROUND_ATTRIBUTE)).toBe(false)
  expect(revoked).toEqual(['blob:img-1', 'blob:img-2'])
})

it('rejects non-images and oversized files without saving', async () => {
  const storage = memoryStorage()
  const { controller } = makeController(storage)
  expect(await controller.choose(new File(['x'], 'a.txt', { type: 'text/plain' }))).toEqual({ ok: false, reason: 'not-image' })
  const huge = png(1)
  Object.defineProperty(huge, 'size', { value: 31 * 1024 * 1024 })
  expect(await controller.choose(huge)).toEqual({ ok: false, reason: 'too-large' })
  expect(storage.state.image).toBeUndefined()
})

it('reports a storage failure and leaves the page untouched', async () => {
  const storage = { ...memoryStorage(), saveImage: async () => { throw new Error('quota') } }
  const { controller, attributes } = makeController(storage)
  expect(await controller.choose(png())).toEqual({ ok: false, reason: 'storage' })
  expect(attributes.size).toBe(0)
})

it('persists a clamped opacity without touching the image', async () => {
  const storage = memoryStorage({ image: png() })
  const { controller, styles } = makeController(storage)
  await controller.restore()
  await controller.setOpacity(5)
  expect(storage.state.opacity).toBe(20)
  expect(styles.get('--dsh-bg-panel')).toBe('20%')
  expect(controller.getSnapshot().previewUrl).toBe('blob:img-1')
  expect(clampOpacity(200)).toBe(95)
})

it('removes every page effect on dispose', async () => {
  const { controller, styles, attributes, revoked } = makeController(memoryStorage({ image: png() }))
  await controller.restore()
  controller.dispose()
  expect(attributes.size).toBe(0)
  expect(styles.size).toBe(0)
  expect(revoked).toEqual(['blob:img-1'])
})

const noImage: BackgroundSnapshot = { hasImage: false, previewUrl: undefined, opacity: 70 }

function mount(snapshot: BackgroundSnapshot, overrides: Partial<ComponentProps<typeof BackgroundSection>> = {}) {
  const actions = {
    choose: vi.fn(async () => ({ ok: true as const })), clear: vi.fn(async () => {}), setOpacity: vi.fn(async () => {}), ...overrides,
  }
  const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
    Object.entries(params ?? {}).reduce((text: string, [name, value]) => text.replace(`{${name}}`, String(value)), en[key])
  const props = { t, useBackground: (select: (value: BackgroundSnapshot) => unknown) => select(snapshot), ...actions }
  render(<BackgroundSection {...(props as unknown as ComponentProps<typeof BackgroundSection>)} />)
  return actions
}

it('passes the chosen file to the controller and localizes a refusal', async () => {
  const choose = vi.fn(async () => ({ ok: false as const, reason: 'too-large' as const }))
  mount(noImage, { choose })
  const file = png()
  await act(async () => { fireEvent.change(screen.getByLabelText(en.choose, { selector: 'input' }), { target: { files: [file] } }) })
  expect(choose).toHaveBeenCalledWith(file)
  expect(screen.getByRole('alert').textContent).toBe(en.errorTooLarge)
})

it('offers replace, remove and opacity once an image is set', async () => {
  const actions = mount({ hasImage: true, previewUrl: 'blob:x', opacity: 60 })
  expect(screen.getByAltText(en.previewAlt).getAttribute('src')).toBe('blob:x')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.clear })) })
  expect(actions.clear).toHaveBeenCalledOnce()
  await act(async () => { fireEvent.change(screen.getByRole('slider'), { target: { value: '80' } }) })
  expect(actions.setOpacity).toHaveBeenCalledWith(80)
})

it('disables the opacity slider while there is no image and keeps both dictionaries in step', () => {
  mount(noImage)
  expect(screen.getByRole<HTMLInputElement>('slider').disabled).toBe(true)
  expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
})
