import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import { needsWelcome, WELCOME_IPC } from '../src/welcome-api.ts'

const electron = vi.hoisted(() => ({
  create: vi.fn<(options: unknown) => ReturnType<typeof createWindow>>(),
  root: '/desktop-app',
  handlers: new Map<string, (event: unknown, value?: unknown, attributes?: unknown) => Promise<unknown>>(),
}))
vi.mock('electron', () => ({
  app: { getAppPath: () => electron.root },
  BrowserWindow: vi.fn(function (options: unknown) { return electron.create(options) }),
  ipcMain: {
    handle: (name: string, handler: (event: unknown, value?: unknown, attributes?: unknown) => Promise<unknown>) => {
      if (electron.handlers.has(name)) throw new Error(`duplicate IPC handler: ${name}`)
      electron.handlers.set(name, handler)
    },
    removeHandler: (name: string) => electron.handlers.delete(name),
  },
}))

const { openWelcomeWindow, welcomeWindowOptions } = await import('../src/welcome-window.ts')

function createWindow() {
  return {
    webContents: {
      mainFrame: {},
      setWindowOpenHandler: vi.fn<(handler: () => { action: string }) => void>(),
      on: vi.fn<(name: string, handler: (event: { preventDefault(): void }) => void) => void>(),
    },
    loadFile: vi.fn<(path: string) => Promise<undefined>>().mockResolvedValue(undefined),
    isDestroyed: vi.fn().mockReturnValue(false),
    destroy: vi.fn(),
    show: vi.fn(),
    once: vi.fn<(name: string, callback: () => void) => void>(),
  }
}

beforeEach(() => { electron.create.mockReset(); electron.handlers.clear() })

const relayState = {
  configured: true, signedIn: false, email: '', signIn: { phase: 'idle' as const }, licensed: false, licenseMessage: '',
}
const operations = {
  analyticsEnabled: async () => true,
  startSignIn: async () => relayState,
  cancelSignIn: async () => relayState,
  copySignInLink: async () => undefined,
  readRelay: async () => relayState,
  activate: async () => ({ ok: true, message: 'ok' }),
  signOut: async () => relayState,
}

describe('desktop welcome window', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('keeps the %s preview fixed-size and sandboxed', (platform) => {
    const options = welcomeWindowOptions(platform, resolveDesktopLocale('zh-CN'))
    expect(options).toMatchObject({
      width: 600, height: 700, useContentSize: true, center: true, show: false,
      resizable: false, maximizable: false, fullscreenable: false,
      webPreferences: {
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
        additionalArguments: ['--dsh-welcome-locale=zh-CN'],
      },
    })
    expect(options.webPreferences?.preload).toMatch(/preload-welcome\.cjs$/u)
    if (platform === 'darwin') {
      expect(options.vibrancy).toBe('menu')
      expect(options.visualEffectState).toBe('active')
      expect(options.trafficLightPosition).toEqual({ x: 21, y: 21 })
    } else if (platform === 'win32') {
      expect(options.backgroundMaterial).toBe('acrylic')
      expect(options.titleBarOverlay).toMatchObject({ height: 42 })
    } else {
      expect(options.backgroundColor).toBe('#FFFFFF')
      expect(options.vibrancy).toBeUndefined()
      expect(options.backgroundMaterial).toBeUndefined()
    }
  })

  it('waits for its local document and blocks renderer navigation', async () => {
    const window = createWindow()
    const loaded = Promise.withResolvers<undefined>()
    window.loadFile.mockReturnValue(loaded.promise)
    electron.create.mockReturnValue(window)
    const opening = openWelcomeWindow(resolveDesktopLocale('en'), operations)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.loadFile).toHaveBeenCalledWith(join(electron.root, 'renderer', 'welcome.html'))
    expect(window.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' })
    const event = { preventDefault: vi.fn() }
    window.webContents.on.mock.calls[0]![1](event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    loaded.resolve(undefined)
    expect(await opening).toBe(window)
    expect(window.show).toHaveBeenCalledOnce()
  })

  it('destroys a window whose document fails to load', async () => {
    const window = createWindow()
    window.loadFile.mockRejectedValue(new Error('missing welcome document'))
    electron.create.mockReturnValue(window)
    await expect(openWelcomeWindow(resolveDesktopLocale('en'), operations)).rejects.toThrow('missing welcome document')
    expect(window.destroy).toHaveBeenCalledOnce()
    expect(electron.handlers.size).toBe(0)
    expect(window.show).not.toHaveBeenCalled()
  })

  it('does not show a window closed while its document was loading', async () => {
    const window = createWindow()
    window.isDestroyed.mockReturnValue(true)
    electron.create.mockReturnValue(window)
    await openWelcomeWindow(resolveDesktopLocale('en'), operations)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.destroy).not.toHaveBeenCalled()
  })

  it('accepts actions only from its own top frame and removes handlers on close', async () => {
    const window = createWindow()
    electron.create.mockReturnValue(window)
    const activate = vi.fn(operations.activate)
    const signOut = vi.fn(operations.signOut)
    const readRelay = vi.fn(operations.readRelay)
    const copySignInLink = vi.fn(operations.copySignInLink)
    await openWelcomeWindow(resolveDesktopLocale('en'), { ...operations, activate, signOut, readRelay, copySignInLink })
    const own = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const read = electron.handlers.get(WELCOME_IPC.read)!
    await expect(read({ ...own, senderFrame: {} })).rejects.toThrow('unowned frame')
    expect(readRelay).not.toHaveBeenCalled()
    expect(await read(own)).toEqual(relayState)
    const activateHandler = electron.handlers.get(WELCOME_IPC.activate)!
    await expect(activateHandler({ sender: {}, senderFrame: {} }, 'CARD')).rejects.toThrow('unowned frame')
    await expect(activateHandler({ ...own, senderFrame: {} }, 'CARD')).rejects.toThrow('unowned frame')
    await expect(activateHandler(own, 42)).rejects.toThrow('invalid card key')
    await expect(activateHandler(own, 'x'.repeat(129))).rejects.toThrow('invalid card key')
    expect(activate).not.toHaveBeenCalled()
    expect(await activateHandler(own, 'ABCD-EFGH')).toEqual({ ok: true, message: 'ok' })
    expect(activate).toHaveBeenCalledExactlyOnceWith('ABCD-EFGH')
    await expect(electron.handlers.get(WELCOME_IPC.signOut)!({ ...own, senderFrame: {} })).rejects.toThrow('unowned frame')
    await electron.handlers.get(WELCOME_IPC.signOut)!(own)
    expect(signOut).toHaveBeenCalledOnce()
    const copy = electron.handlers.get(WELCOME_IPC.copyLink)!
    await expect(copy({ ...own, senderFrame: {} })).rejects.toThrow('unowned frame')
    await copy(own)
    expect(copySignInLink).toHaveBeenCalledOnce()
    window.once.mock.calls[0]![1]()
    expect(electron.handlers.size).toBe(0)
  })

  it('does not show a superseded window when its delayed document finishes loading', async () => {
    const previous = createWindow()
    const current = createWindow()
    const loaded = Promise.withResolvers<undefined>()
    previous.loadFile.mockReturnValue(loaded.promise)
    electron.create.mockReturnValueOnce(previous).mockReturnValueOnce(current)
    const opening = openWelcomeWindow(resolveDesktopLocale('en'), operations)
    await openWelcomeWindow(resolveDesktopLocale('en'), operations)
    loaded.resolve(undefined)
    await opening
    expect(previous.show).not.toHaveBeenCalled()
    expect(current.show).toHaveBeenCalledOnce()
    previous.once.mock.calls[0]![1]()
    current.once.mock.calls[0]![1]()
  })

  it('replaces handlers before the previous native window emits closed', async () => {
    const previous = createWindow()
    const current = createWindow()
    electron.create.mockReturnValueOnce(previous).mockReturnValueOnce(current)
    const previousStart = vi.fn(operations.startSignIn)
    const currentStart = vi.fn(operations.startSignIn)
    await openWelcomeWindow(resolveDesktopLocale('en'), { ...operations, startSignIn: previousStart })
    const previousHandler = electron.handlers.get(WELCOME_IPC.start)!
    const previousSender = { sender: previous.webContents, senderFrame: previous.webContents.mainFrame }
    await openWelcomeWindow(resolveDesktopLocale('en'), { ...operations, startSignIn: currentStart })
    const currentHandler = electron.handlers.get(WELCOME_IPC.start)!
    await expect(previousHandler(previousSender)).rejects.toThrow('unowned frame')
    await expect(currentHandler(previousSender)).rejects.toThrow('unowned frame')
    previous.once.mock.calls[0]![1]()
    expect(electron.handlers.get(WELCOME_IPC.start)).toBe(currentHandler)
    await currentHandler({ sender: current.webContents, senderFrame: current.webContents.mainFrame })
    expect(currentStart).toHaveBeenCalledOnce()
    expect(previousStart).not.toHaveBeenCalled()
    current.once.mock.calls[0]![1]()
    expect(electron.handlers.size).toBe(0)
  })

  it('shows the entry until the relay account is signed in with a valid card', () => {
    expect(needsWelcome({ relayReady: false })).toBe(true)
    expect(needsWelcome({ relayReady: true })).toBe(false)
  })
})

it('accepts only permitted event fields and reads the current policy over IPC', async () => {
  const window = createWindow()
  electron.create.mockReturnValue(window)
  const analytics = vi.fn(async () => {})
  let enabled = true
  await openWelcomeWindow(resolveDesktopLocale('en'), { ...operations, analytics, analyticsEnabled: async () => enabled })
  const own = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const policy = electron.handlers.get(WELCOME_IPC.analyticsEnabled)!
  expect(await policy(own)).toBe(true)
  enabled = false
  expect(await policy(own)).toBe(false)
  const report = electron.handlers.get(WELCOME_IPC.analytics)!
  await report(own, 'auth_page_click', { button_name: 'sign_in' })
  expect(analytics).toHaveBeenLastCalledWith('auth_page_click', { button_name: 'sign_in' })
  await expect(report(own, 'auth_page_click', { button_name: 'sign_in', token: 'private' })).rejects.toThrow('invalid analytics')
  await expect(report(own, 'desktop_app_launch', {})).rejects.toThrow('invalid analytics')
  await expect(report(own, 'auth_page_view', null)).rejects.toThrow('invalid analytics')
  await expect(report(own, 'auth_page_click', { button_name: 'api-key' })).rejects.toThrow('invalid analytics')
  await expect(report(own, 'api_key_save_click', {})).rejects.toThrow('invalid analytics')
})
