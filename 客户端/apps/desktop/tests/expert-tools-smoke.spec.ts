import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { smokeExpertTools } from '../scripts/expert-tools-smoke.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'expert-tools-smoke-'))
  roots.push(home)
  return home
}

it('runs the desktop taskboard and message bus with the bundled Python runtime', async () => {
  const cwd = makeHome()
  const commands: { file: string; args: string[]; options: RunOptions }[] = []
  type RunOptions = { cwd: string; encoding: 'utf8'; env: NodeJS.ProcessEnv; timeout: number; windowsHide: true }
  const responses = [
    { stdout: '{"ok":true,"cmd":"create","data":{}}' },
    { stdout: '{"ok":true,"cmd":"list","data":{"tasks":[{"title":"desktop packaged smoke"}]}}' },
    { stdout: 'message queued' },
    { stdout: 'bundled Python message bus smoke' },
  ]
  const run = vi.fn(async (file: string, args: string[], options: RunOptions) => {
    commands.push({ file, args, options })
    const response = responses.shift()
    if (response === undefined) throw new Error('unexpected additional command')
    return response
  })

  await smokeExpertTools({
    python: 'bundled-python.exe',
    tools: join(cwd, 'app.asar', 'dsh', 'node_modules', 'bailan-expert-orchestrator', 'skills', 'expert-orchestration', 'tools'),
    cwd, env: { DSH_EXPERT_ORCHESTRATOR_PYTHON: 'bundled-python.exe' }, run,
  })

  expect(commands).toHaveLength(4)
  expect(commands.every(command => command.file === 'bundled-python.exe')).toBe(true)
  expect(commands.map(command => command.args.slice(0, 3))).toEqual([
    expect.arrayContaining(['-I', '-B', expect.stringContaining('taskboard.py')]),
    expect.arrayContaining(['-I', '-B', expect.stringContaining('taskboard.py')]),
    expect.arrayContaining(['-I', '-B', expect.stringContaining('bus.py')]),
    expect.arrayContaining(['-I', '-B', expect.stringContaining('bus.py')]),
  ])
  expect(commands[0]?.args).toEqual(expect.arrayContaining(['--json', 'create', 'desktop packaged smoke']))
  expect(commands[1]?.args).toEqual(expect.arrayContaining(['--json', 'list']))
  expect(commands[2]?.args).toEqual(expect.arrayContaining(['send', '--from', 'desktop-smoke', '--to', 'coordinator']))
  expect(commands[3]?.args).toEqual(expect.arrayContaining(['read', '--box', 'coordinator', '--all-boxes']))
  expect(commands.every(command => command.options.cwd === cwd && command.options.encoding === 'utf8'
    && command.options.timeout === 30_000 && command.options.windowsHide)).toBe(true)
  expect(commands.every(command => command.args[2]?.includes('app.asar.unpacked'))).toBe(true)
})

it('rejects a taskboard that fails to return its smoke task', async () => {
  const cwd = makeHome()
  const run = vi.fn()
    .mockResolvedValueOnce({ stdout: '{"ok":true,"cmd":"create","data":{}}' })
    .mockResolvedValueOnce({ stdout: '{"ok":true,"cmd":"list","data":{"tasks":[]}}' })

  await expect(smokeExpertTools({
    python: 'bundled-python.exe',
    tools: join(cwd, 'node_modules', 'bailan-expert-orchestrator', 'skills', 'expert-orchestration', 'tools'),
    cwd, env: {}, run,
  })).rejects.toThrow(/could not read its smoke task/u)
  expect(run).toHaveBeenCalledTimes(2)
})

it('stops when the packaged taskboard returns invalid output', async () => {
  const cwd = makeHome()
  const run = vi.fn().mockResolvedValue({ stdout: 'python traceback' })

  await expect(smokeExpertTools({
    python: 'bundled-python.exe',
    tools: join(cwd, 'node_modules', 'bailan-expert-orchestrator', 'skills', 'expert-orchestration', 'tools'),
    cwd, env: {}, run,
  })).rejects.toThrow(/returned invalid JSON/u)
  expect(run).toHaveBeenCalledTimes(1)
})

it('rejects a message bus that cannot read back its sent message', async () => {
  const cwd = makeHome()
  const run = vi.fn()
    .mockResolvedValueOnce({ stdout: '{"ok":true,"cmd":"create","data":{}}' })
    .mockResolvedValueOnce({ stdout: '{"ok":true,"cmd":"list","data":{"tasks":[{"title":"desktop packaged smoke"}]}}' })
    .mockResolvedValueOnce({ stdout: 'message queued' })
    .mockResolvedValueOnce({ stdout: 'empty inbox' })

  await expect(smokeExpertTools({
    python: 'bundled-python.exe',
    tools: join(cwd, 'node_modules', 'bailan-expert-orchestrator', 'skills', 'expert-orchestration', 'tools'),
    cwd, env: {}, run,
  })).rejects.toThrow(/message bus could not read/u)
  expect(run).toHaveBeenCalledTimes(4)
})
