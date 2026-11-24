import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BrowserToolError } from '../src/errors.ts'
import { currentBinaryHost, nativeBinaryPackage, resolveBrowserExecutable, resolveCliBinary, resolveCliProgram, unpackedBinaryPath } from '../src/executable.ts'
import type { BrowserHost } from '../src/executable.ts'

describe('nativeBinaryPackage', () => {
  it.each([
    ['darwin', 'arm64', false, '@agent-browser/cli-darwin-arm64', 'agent-browser'],
    ['darwin', 'x64', false, '@agent-browser/cli-darwin-x64', 'agent-browser'],
    ['linux', 'x64', false, '@agent-browser/cli-linux-x64-gnu', 'agent-browser'],
    ['linux', 'arm64', false, '@agent-browser/cli-linux-arm64-gnu', 'agent-browser'],
    ['linux', 'x64', true, '@agent-browser/cli-linux-x64-musl', 'agent-browser'],
    ['linux', 'arm64', true, '@agent-browser/cli-linux-arm64-musl', 'agent-browser'],
    ['win32', 'x64', false, '@agent-browser/cli-win32-x64-msvc', 'agent-browser.exe'],
    ['win32', 'arm64', false, '@agent-browser/cli-win32-x64-msvc', 'agent-browser.exe'],
  ] as const)('names the package for %s-%s (musl: %s)', (platform, arch, musl, packageName, file) => {
    expect(nativeBinaryPackage({ platform, arch, musl })).toEqual({ packageName, file })
  })

  it.each([
    ['linux', 'ia32'],
    ['win32', 'ia32'],
    ['freebsd', 'x64'],
    ['android', 'arm64'],
  ] as const)('has no package for %s-%s', (platform, arch) => {
    expect(nativeBinaryPackage({ platform, arch, musl: false })).toBeUndefined()
  })
})

describe('resolveCliBinary', () => {
  it('resolves the binary installed for the running host', () => {
    expect(currentBinaryHost()).toMatchObject({ platform: process.platform, arch: process.arch })
    const binary = resolveCliBinary()
    expect(isAbsolute(binary)).toBe(true)
    expect(existsSync(binary)).toBe(true)
    expect(binary.endsWith(process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser')).toBe(true)
    expect(resolveCliProgram()).toEqual([binary])
  })

  it('reads the libc flavor only on Linux', () => {
    const runtime = (platform: NodeJS.Platform, header: { glibcVersionRuntime?: string }) => {
      let reports = 0
      return { platform, arch: 'x64', report: { getReport: () => { reports += 1; return { header } } }, reports: () => reports }
    }
    expect(currentBinaryHost(runtime('linux', { glibcVersionRuntime: '2.39' }))).toEqual({ platform: 'linux', arch: 'x64', musl: false })
    expect(currentBinaryHost(runtime('linux', {}))).toEqual({ platform: 'linux', arch: 'x64', musl: true })
    const windows = runtime('win32', {})
    expect(currentBinaryHost(windows)).toEqual({ platform: 'win32', arch: 'x64', musl: false })
    expect(windows.reports()).toBe(0)
  })

  it('maps an archived path to the unpacked directory only under Electron', () => {
    const windows = 'C:\\app\\resources\\app.asar\\dsh\\node_modules\\x\\bin\\agent-browser.exe'
    const posix = '/Applications/App.app/Contents/Resources/app.asar/dsh/node_modules/x/bin/agent-browser'
    expect(unpackedBinaryPath(windows, true)).toBe('C:\\app\\resources\\app.asar.unpacked\\dsh\\node_modules\\x\\bin\\agent-browser.exe')
    expect(unpackedBinaryPath(posix, true)).toBe('/Applications/App.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/x/bin/agent-browser')
    expect(unpackedBinaryPath(windows, false)).toBe(windows)
    // A file merely named like an archive is not an archive directory.
    expect(unpackedBinaryPath('/opt/tools/agent-browser.asar', true)).toBe('/opt/tools/agent-browser.asar')
  })

  it('reports an unsupported host and a platform package that is not installed', () => {
    expect(() => resolveCliBinary({ platform: 'freebsd', arch: 'x64', musl: false }))
      .toThrow(new BrowserToolError('browser automation is unavailable on freebsd-x64', 'BROWSER_UNAVAILABLE'))
    // Package managers install only the running host's platform package.
    const foreign = process.platform === 'darwin'
      ? { platform: 'linux' as const, arch: 'x64', musl: true }
      : { platform: 'darwin' as const, arch: 'arm64', musl: false }
    expect(() => resolveCliBinary(foreign)).toThrow(new BrowserToolError(
      `browser automation is unavailable: its program for ${foreign.platform}-${foreign.arch} is not installed`,
      'BROWSER_UNAVAILABLE',
    ))
  })
})

describe('resolveBrowserExecutable', () => {
  const windowsEnv = { 'ProgramFiles': 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', 'LOCALAPPDATA': 'C:\\Users\\me\\AppData\\Local' }

  function host(platform: NodeJS.Platform, installed: readonly string[], env: NodeJS.ProcessEnv = {}): BrowserHost & { probed: string[] } {
    const probed: string[] = []
    return { platform, env, probed, exists: (path) => { probed.push(path); return installed.includes(path) } }
  }

  it('uses the configured executable without probing', () => {
    const facts = host('win32', [], windowsEnv)
    expect(resolveBrowserExecutable('D:\\Browsers\\chrome.exe', facts)).toBe('D:\\Browsers\\chrome.exe')
    expect(facts.probed).toEqual([])
  })

  it.each([
    ['win32', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', windowsEnv],
    ['win32', 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe', windowsEnv],
    ['darwin', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', {}],
    ['linux', '/usr/bin/chromium', {}],
  ] as const)('leaves discovery to the CLI when Chrome is installed on %s at %s', (platform, chrome, env) => {
    const edge = platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : '/usr/bin/microsoft-edge'
    expect(resolveBrowserExecutable(undefined, host(platform, [chrome, edge], env))).toBeUndefined()
  })

  it.each([
    ['win32', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', windowsEnv],
    ['win32', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', windowsEnv],
    ['darwin', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', {}],
    ['linux', '/usr/bin/microsoft-edge-stable', {}],
  ] as const)('names Microsoft Edge on %s when Chrome is absent', (platform, edge, env) => {
    expect(resolveBrowserExecutable(undefined, host(platform, [edge], env))).toBe(edge)
  })

  it('names no browser when neither is installed, the roots are unset, or the platform is unknown', () => {
    expect(resolveBrowserExecutable(undefined, host('win32', [], windowsEnv))).toBeUndefined()
    const unset = host('win32', ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'], { ProgramFiles: '' })
    expect(resolveBrowserExecutable(undefined, unset)).toBeUndefined()
    expect(unset.probed).toEqual([])
    expect(resolveBrowserExecutable(undefined, host('freebsd', ['/usr/bin/microsoft-edge']))).toBeUndefined()
  })
})
