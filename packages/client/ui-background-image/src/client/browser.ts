/** Browser seams for the background image: IndexedDB storage and canvas downscaling. */
import type { BackgroundStorage } from './controller.ts'

const DB_NAME = 'dsh-background-image'
const STORE = 'kv'
const IMAGE_KEY = 'image'
const OPACITY_KEY = 'opacity'
/** Longest edge kept after downscaling; larger photos are resampled. */
export const MAX_EDGE = 2560

/** @param request - IndexedDB request. @returns its result as a promise. */
function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('indexeddb request failed')) }
  })
}

/** Open the store lazily so a blocked database only fails when used. @returns storage plus a closer. */
export function openIndexedDbStorage(): { storage: BackgroundStorage; close: () => void } {
  let opened: Promise<IDBDatabase> | undefined
  const open = () => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE) }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('indexeddb open failed')) }
  })
  const store = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode).objectStore(STORE)
  const storage: BackgroundStorage = {
    loadImage: async () => {
      const value: unknown = await wrap((await store('readonly')).get(IMAGE_KEY))
      return value instanceof Blob ? value : undefined
    },
    saveImage: async (image) => { await wrap((await store('readwrite')).put(image, IMAGE_KEY)) },
    clearImage: async () => { await wrap((await store('readwrite')).delete(IMAGE_KEY)) },
    loadOpacity: async () => {
      const value: unknown = await wrap((await store('readonly')).get(OPACITY_KEY))
      return typeof value === 'number' ? value : undefined
    },
    saveOpacity: async (percent) => { await wrap((await store('readwrite')).put(percent, OPACITY_KEY)) },
  }
  return { storage, close: () => { void opened?.then((db) => { db.close() }, () => undefined) } }
}

/** @param file - chosen image. @returns a JPEG whose longest edge is at most MAX_EDGE. */
export async function downscaleImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('canvas unavailable')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob === null) reject(new Error('encode failed'))
        else resolve(blob)
      }, 'image/jpeg', 0.88)
    })
  } finally {
    bitmap.close()
  }
}
