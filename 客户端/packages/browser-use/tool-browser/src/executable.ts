/**
 * Locate the packaged agent-browser binary and choose the browser it drives.
 * @module @deepseek-ai/dsh-tool-browser/executable
 */

import { createRequire } from 'node:module'
import { dirname, join, win32 } from 'node:path'
import { BrowserToolError } from './errors.ts'

/** The npm package that carries one host's native CLI binary, and the file inside its `bin/`. */
export interface NativeBinaryPackage {
  packageName: string
  file: string
}

/** Host facts that select a native CLI binary. */
export interface BinaryHost {
  platform: NodeJS.Platform
  arch: string
  /** Whether a Linux host links musl instead of glibc; ignored elsewhere. */
  musl: boolean
}

/**
 * Name the agent-browser platform package for a host, following the layout
 * of the pinned `agent-browser` release's optional dependencies.
 * @param host - platform, CPU architecture, and Linux libc flavor.
 * @returns the package and binary file name, or `undefined` for a host the release does not ship.
 */
export function nativeBinaryPackage(host: BinaryHost): NativeBinaryPackage | undefined {
  if (host.arch !== 'x64' && host.arch !== 'arm64') return undefined
  switch (host.platform) {
    case 'darwin':
      return { packageName: `@agent-browser/cli-darwin-${host.arch}`, file: 'agent-browser' }
    case 'linux':
      return { packageName: `@agent-browser/cli-linux-${host.arch}-${host.musl ? 'musl' : 'gnu'}`, file: 'agent-browser' }
    // Windows on ARM runs the published x64 binary through emulation.
    case 'win32':
      return { packageName: '@agent-browser/cli-win32-x64-msvc', file: 'agent-browser.exe' }
    default:
      return undefined
  }
}

/** The parts of a Node process that identify its host. */
export interface HostRuntime {
  platform: NodeJS.Platform
  arch: string
  report: {
    /**
     * Produce Node's diagnostic report.
     * @returns the report object; its `header` names the linked glibc version, when there is one.
     */
    getReport(): object
  }
}

/**
 * Read a runtime's binary-selection facts.
 * @param runtime - the process to describe; defaults to the running one.
 * @returns platform, architecture, and the libc flavor Node reports on Linux.
 */
export function currentBinaryHost(runtime: HostRuntime = process): BinaryHost {
  return {
    platform: runtime.platform,
    arch: runtime.arch,
    // Node reports a glibc version only when it is linked against glibc.
    musl: runtime.platform === 'linux'
      && (runtime.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime === undefined,
  }
}

/**
 * Map a module path to the file the operating system can execute. A packaged
 * Electron application keeps native executables in a directory beside its
 * archive; the archive itself is readable only through Electron's file APIs.
 * @param path - a resolved module path.
 * @param electron - whether the process is an Electron runtime.
 * @returns `path`, with an archive segment replaced by its unpacked directory under Electron.
 */
export function unpackedBinaryPath(path: string, electron: boolean): string {
  return electron ? path.replace(/\.asar(?=[\\/])/u, '.asar.unpacked') : path
}

/**
 * Resolve the native CLI binary installed with this package.
 * @param host - host facts; defaults to the running process.
 * @returns the binary's absolute path.
 * @throws BrowserToolError `BROWSER_UNAVAILABLE` when the host is unsupported or the platform package is absent.
 */
export function resolveCliBinary(host: BinaryHost = currentBinaryHost()): string {
  const target = nativeBinaryPackage(host)
  if (target === undefined) {
    throw new BrowserToolError(`browser automation is unavailable on ${host.platform}-${host.arch}`, 'BROWSER_UNAVAILABLE')
  }
  let binary: string
  try {
    const cli = createRequire(import.meta.url).resolve('agent-browser/package.json')
    binary = join(dirname(createRequire(cli).resolve(`${target.packageName}/package.json`)), 'bin', target.file)
  } catch (error: unknown) {
    throw new BrowserToolError(
      `browser automation is unavailable: its program for ${host.platform}-${host.arch} is not installed`,
      'BROWSER_UNAVAILABLE',
      { cause: error },
    )
  }
  return unpackedBinaryPath(binary, process.versions.electron !== undefined)
}

/**
 * Resolve the argument vector that starts the packaged CLI on this host.
 * @returns the native binary's absolute path as a one-element vector.
 * @throws BrowserToolError `BROWSER_UNAVAILABLE` when the host has no installed binary.
 */
export function resolveCliProgram(): readonly string[] {
  return [resolveCliBinary()]
}

/** Host facts that locate an installed browser. */
export interface BrowserHost {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /**
   * Report whether an executable exists.
   * @param path - absolute candidate path.
   * @returns true when the file is present.
   */
  exists(path: string): boolean
}

/** Standard install locations of one browser on a host. */
function installLocations(host: BrowserHost, windows: string, mac: string, linux: readonly string[]): string[] {
  switch (host.platform) {
    case 'win32':
      return [host.env['ProgramFiles'], host.env['ProgramFiles(x86)'], host.env['LOCALAPPDATA']]
        .filter((root): root is string => root !== undefined && root.length > 0)
        .map(root => win32.join(root, windows))
    case 'darwin': return [mac]
    case 'linux': return [...linux]
    default: return []
  }
}

/**
 * Choose the browser executable for a launch. The CLI discovers Chrome,
 * Chromium, and Brave on its own but not Microsoft Edge, so Edge is named
 * explicitly when it is installed and Chrome is not.
 * @param configured - the deployment's explicit executable, when set.
 * @param host - platform, environment, and file-existence probe.
 * @returns the executable to pass to the CLI, or `undefined` to use its own discovery.
 */
export function resolveBrowserExecutable(configured: string | undefined, host: BrowserHost): string | undefined {
  if (configured !== undefined) return configured
  const chrome = installLocations(
    host,
    win32.join('Google', 'Chrome', 'Application', 'chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  )
  if (chrome.some(path => host.exists(path))) return undefined
  return installLocations(
    host,
    win32.join('Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
  ).find(path => host.exists(path))
}
