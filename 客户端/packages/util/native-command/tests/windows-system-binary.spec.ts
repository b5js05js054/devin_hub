import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { windowsSystemBinary } from '../src/path-opener.ts'

describe('windowsSystemBinary', () => {
  it('resolves Explorer in the system root, Windows PowerShell in its versioned directory, and wslpath in System32', () => {
    const env = { SystemRoot: 'C:\\WinDir' }
    expect(windowsSystemBinary('explorer.exe', env)).toBe(join('C:\\WinDir', 'explorer.exe'))
    expect(windowsSystemBinary('powershell.exe', env))
      .toBe(join('C:\\WinDir', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    expect(windowsSystemBinary('wslpath.exe', env)).toBe(join('C:\\WinDir', 'System32', 'wslpath.exe'))
  })

  it('prefers SystemRoot over windir and falls back to C:\\Windows', () => {
    expect(windowsSystemBinary('explorer.exe', { SystemRoot: 'D:\\OS', windir: 'D:\\Ignored' }))
      .toBe(join('D:\\OS', 'explorer.exe'))
    expect(windowsSystemBinary('explorer.exe', { windir: 'D:\\OS' }))
      .toBe(join('D:\\OS', 'explorer.exe'))
    expect(windowsSystemBinary('explorer.exe', {})).toBe(join('C:\\Windows', 'explorer.exe'))
  })

  // A resolved path that names no file fails every spawn with ENOENT; the
  // injected-runner suites cannot see that, so the real host is asked here.
  it.skipIf(process.platform !== 'win32')('resolves executables that exist on this Windows host', () => {
    expect(existsSync(windowsSystemBinary('explorer.exe', process.env))).toBe(true)
    expect(existsSync(windowsSystemBinary('powershell.exe', process.env))).toBe(true)
  })
})
