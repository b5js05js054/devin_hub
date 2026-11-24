import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { expect, it } from 'vitest'

it.each([
  { outcome: { success: false }, exitCode: 1, label: 'fail', immediate: false },
  { outcome: { success: false }, exitCode: 1, label: 'fail', immediate: true },
  { outcome: { code: 1, signal: null, timedOut: false, fatalObserved: false, launchError: false, outputError: false, terminationError: false }, exitCode: 1, label: 'fail', immediate: false },
  { outcome: { code: 0, signal: null, timedOut: true, fatalObserved: false, launchError: false, outputError: false, terminationError: false }, exitCode: 1, label: 'fail', immediate: false },
  { outcome: { success: true }, exitCode: 0, label: 'ok', immediate: false },
  { outcome: { success: true }, exitCode: 0, label: 'ok', immediate: false, retry: true },
  { outcome: { code: 0, signal: null, timedOut: false, fatalObserved: false, launchError: false, outputError: false, terminationError: false }, exitCode: 0, label: 'ok', immediate: false },
])('reports $label for a finished packaging stage: $outcome', async ({ outcome, exitCode, label, immediate, retry }) => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-progress-'))
  let child: ReturnType<typeof spawn> | undefined
  let closed: Promise<number | null> | undefined
  let observed: Promise<void> | undefined
  try {
    const scripts = join(root, 'scripts')
    const desktop = join(root, 'apps', 'desktop')
    const bin = join(root, 'bin')
    await Promise.all([mkdir(scripts), mkdir(desktop, { recursive: true }), mkdir(bin)])
    for (const name of await readdir(import.meta.dirname)) {
      if (/^package-desktop(?:-.*)?\.mjs$/u.test(name)) await copyFile(join(import.meta.dirname, name), join(scripts, name))
    }
    await writeFile(join(desktop, '.env.windows'), '')
    if (retry) {
      const oldRun = join(desktop, '.desktop-build', 'packaging-runs', 'previous')
      await mkdir(oldRun, { recursive: true })
      await writeFile(join(oldRun, 'events.jsonl'), [
        { type: 'stage-start', stage: 'runtime:install', stageId: 'old', time: new Date().toISOString() },
        { type: 'stage-end', stage: 'runtime:install', stageId: 'old', success: false },
      ].map(event => JSON.stringify(event)).join('\n'))
    }
    const fixture = join(root, 'fake-pnpm.mjs')
    await writeFile(fixture, `import { existsSync, mkdirSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
if (process.env.FIXTURE_RETRY === '1') await new Promise(resolve => setTimeout(resolve, 1000))
const directory = join(process.cwd(), 'apps', 'desktop', '.desktop-build', 'packaging-runs', 'fixture')
mkdirSync(directory, { recursive: true })
process.stdout.write('DESKTOP_PACKAGING_RECORD ' + directory + '\\n')
const start = Date.now()
writeFileSync(join(directory, 'events.jsonl'), [
  { type: 'stage-start', stage: 'runtime:install', stageId: 'install', time: new Date(start).toISOString() },
  { type: 'stage-end', stage: 'runtime:install', stageId: 'install', time: new Date(start + 1000).toISOString(), elapsedMs: 1000, ...JSON.parse(process.env.STAGE_OUTCOME) },
].map(event => JSON.stringify(event)).join('\\n') + '\\n')
if (process.env.FIXTURE_IMMEDIATE === '1') {
  process.exitCode = Number(process.env.FIXTURE_EXIT)
} else {
  function observe() {
    if (!existsSync(join(process.cwd(), 'observed'))) return
    watcher.close()
    process.exitCode = Number(process.env.FIXTURE_EXIT)
  }
  const watcher = watch(process.cwd(), observe)
  observe()
  setTimeout(() => { watcher.close(); process.exitCode = 2 }, 5000).unref()
}
`)
    const launcher = join(bin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
    await writeFile(launcher, process.platform === 'win32'
      ? '@echo off\r\n"%FIXTURE_NODE%" "%FIXTURE_ENTRY%"\r\n'
      : '#!/bin/sh\nexec "$FIXTURE_NODE" "$FIXTURE_ENTRY"\n')
    if (process.platform !== 'win32') await chmod(launcher, 0o755)
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(name)))
    const pathName = Object.keys(environment).find(name => name.toLowerCase() === 'path') ?? 'PATH'
    child = spawn(process.execPath, [join(scripts, 'package-desktop.mjs')], {
      cwd: root, env: { ...environment, [pathName]: bin + delimiter + (environment[pathName] ?? ''),
        FIXTURE_NODE: process.execPath, FIXTURE_ENTRY: fixture, STAGE_OUTCOME: JSON.stringify(outcome), FIXTURE_EXIT: String(exitCode), FIXTURE_IMMEDIATE: immediate ? '1' : '0', FIXTURE_RETRY: retry ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let errors = ''
    closed = new Promise(resolveClose => {
      child!.once('error', error => { errors += error.stack ?? error.message })
      child!.once('close', code => resolveClose(code))
    })
    child.stdout!.on('data', (data: Buffer) => {
      output += data.toString()
      if (/  (?:ok|fail)  runtime:install/u.test(output)) observed ??= writeFile(join(root, 'observed'), '')
    })
    child.stderr!.on('data', (data: Buffer) => { errors += data.toString() })
    expect(await closed, errors).toBe(exitCode)
    await observed
    expect(output).toContain('  ' + label + '  runtime:install')
    if (label === 'fail') {
      expect(output).not.toContain('  ok  runtime:install')
      expect(output).toContain('打包失败')
      expect(output).not.toContain('100%')
      if (!immediate) expect(output).toContain('(0/27)')
    } else {
      expect(output).toContain('100%')
      expect(output).not.toContain('  fail  runtime:install')
    }
    const log = await readFile(join(desktop, '.desktop-build', 'package-desktop.log'), 'utf8')
    expect(log).toContain('DESKTOP_PACKAGING_RECORD ')
  } finally {
    try {
      // The fixture exits after five seconds even if the wrapper never observes its stage.
      await closed
      await observed
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 })
    }
  }
}, 15_000)
