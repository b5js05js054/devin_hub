/** Background image state: persisted through a storage seam, applied to the page body through CSS custom properties. */

/** Persistence seam; the browser implementation is IndexedDB, tests use memory. */
export interface BackgroundStorage {
  /** @returns the saved image, or undefined when none is set. */
  loadImage: () => Promise<Blob | undefined>
  /** @param image - image bytes to keep on this device. */
  saveImage: (image: Blob) => Promise<void>
  clearImage: () => Promise<void>
  /** @returns the saved panel opacity percent, or undefined for the default. */
  loadOpacity: () => Promise<number | undefined>
  saveOpacity: (percent: number) => Promise<void>
}

/** Page element that receives the attribute and custom properties. */
export interface BackgroundTarget {
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
  style: { setProperty: (name: string, value: string) => void; removeProperty: (name: string) => void }
}

/** Observable snapshot rendered by the settings section. */
export interface BackgroundSnapshot {
  readonly hasImage: boolean
  /** Object URL of the saved image for the preview, undefined without an image. */
  readonly previewUrl: string | undefined
  /** Panel opacity percent drawn over the image. */
  readonly opacity: number
}

/** Result of choosing an image file. */
export type ChooseResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'not-image' | 'too-large' | 'storage' }

/** Controller seams. */
export interface BackgroundControllerOptions {
  readonly storage: BackgroundStorage
  readonly target: BackgroundTarget
  /** Turn a chosen file into the stored, size-bounded image. */
  readonly prepare: (file: File) => Promise<Blob>
  readonly createObjectUrl: (blob: Blob) => string
  readonly revokeObjectUrl: (url: string) => void
}

export const DEFAULT_OPACITY = 70
export const MIN_OPACITY = 20
export const MAX_OPACITY = 95
/** Largest file accepted before downscaling. */
export const MAX_SOURCE_BYTES = 30 * 1024 * 1024

export const BACKGROUND_ATTRIBUTE = 'data-dsh-bg-image'
const IMAGE_PROPERTY = '--dsh-bg-image'
const OPACITY_PROPERTY = '--dsh-bg-panel'

/** Clamp a slider value to the supported range. @param percent - requested percent. @returns bounded integer percent. */
export function clampOpacity(percent: number): number {
  return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, Math.round(percent)))
}

/** Background controller owned by one plugin lifetime. */
export class BackgroundController {
  private snapshot: BackgroundSnapshot = { hasImage: false, previewUrl: undefined, opacity: DEFAULT_OPACITY }
  private readonly listeners = new Set<() => void>()
  private disposed = false

  constructor(private readonly options: BackgroundControllerOptions) {}

  /** @returns current snapshot (stable between changes). */
  getSnapshot = (): BackgroundSnapshot => this.snapshot

  /** @param listener - change callback. @returns unsubscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Read persisted values and apply them. Storage failures leave the default look. */
  async restore(): Promise<void> {
    const [image, opacity] = await Promise.all([
      this.options.storage.loadImage().catch(() => undefined),
      this.options.storage.loadOpacity().catch(() => undefined),
    ])
    if (this.disposed) return
    this.apply(image, opacity === undefined ? DEFAULT_OPACITY : clampOpacity(opacity))
  }

  /** @param file - user-chosen file. @returns whether it was accepted and saved. */
  async choose(file: File): Promise<ChooseResult> {
    if (!file.type.startsWith('image/')) return { ok: false, reason: 'not-image' }
    if (file.size > MAX_SOURCE_BYTES) return { ok: false, reason: 'too-large' }
    try {
      const image = await this.options.prepare(file)
      await this.options.storage.saveImage(image)
      if (!this.disposed) this.apply(image, this.snapshot.opacity)
      return { ok: true }
    } catch {
      return { ok: false, reason: 'storage' }
    }
  }

  /** Remove the saved image. */
  async clear(): Promise<void> {
    await this.options.storage.clearImage()
    if (!this.disposed) this.apply(undefined, this.snapshot.opacity)
  }

  /** @param percent - requested panel opacity. */
  async setOpacity(percent: number): Promise<void> {
    const opacity = clampOpacity(percent)
    this.apply(undefined, opacity, true)
    await this.options.storage.saveOpacity(opacity)
  }

  /** Remove page effects and release the preview URL. */
  dispose(): void {
    this.disposed = true
    this.release()
    this.options.target.removeAttribute(BACKGROUND_ATTRIBUTE)
    this.options.target.style.removeProperty(IMAGE_PROPERTY)
    this.options.target.style.removeProperty(OPACITY_PROPERTY)
    this.listeners.clear()
  }

  private release(): void {
    if (this.snapshot.previewUrl !== undefined) this.options.revokeObjectUrl(this.snapshot.previewUrl)
  }

  /** @param image - new image; ignored when keepImage is set. */
  private apply(image: Blob | undefined, opacity: number, keepImage = false): void {
    const { target } = this.options
    let previewUrl = this.snapshot.previewUrl
    if (!keepImage) {
      this.release()
      previewUrl = image === undefined ? undefined : this.options.createObjectUrl(image)
    }
    if (previewUrl === undefined) {
      target.removeAttribute(BACKGROUND_ATTRIBUTE)
      target.style.removeProperty(IMAGE_PROPERTY)
    } else {
      target.style.setProperty(IMAGE_PROPERTY, `url("${previewUrl}")`)
      target.setAttribute(BACKGROUND_ATTRIBUTE, '')
    }
    target.style.setProperty(OPACITY_PROPERTY, `${opacity}%`)
    this.snapshot = { hasImage: previewUrl !== undefined, previewUrl, opacity }
    for (const listener of this.listeners) listener()
  }
}
