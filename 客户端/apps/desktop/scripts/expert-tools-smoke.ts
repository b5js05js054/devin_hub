/** Execute the bundled expert's Python taskboard and message bus from a packaged runtime. */

import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

interface ToolRunOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly timeout: number
  readonly encoding: 'utf8'
  readonly windowsHide: true
}

interface ToolRunResult {
  readonly stdout: string
}

interface ExpertToolSmokeOptions {
  readonly python: string
  readonly tools: string
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly run?: ToolRunner | undefined
}

type ToolRunner = (file: string, args: string[], options: ToolRunOptions) => Promise<ToolRunResult>

const runTool: ToolRunner = async (file, args, options) => promisify(execFile)(file, args, options)

/**
 * Execute the packaged board and bus commands using Desktop's bundled interpreter.
 * @param config - Interpreter, script directory, private working directory, environment, and optional test runner.
 * @returns Completion after taskboard records a task and the bus reads its message.
 */
export async function smokeExpertTools(config: ExpertToolSmokeOptions): Promise<void> {
  const { python, cwd, env } = config
  const run = config.run ?? runTool
  const tools = config.tools.replace(/\.asar([\\/])/gu, '.asar.unpacked$1')
  const taskboard = join(tools, 'taskboard.py')
  const bus = join(tools, 'bus.py')
  const options: ToolRunOptions = { cwd, encoding: 'utf8', env, timeout: 30_000, windowsHide: true }
  const board = join(cwd, '.expert-taskboards', 'desktop-smoke.json')
  mkdirSync(dirname(board), { recursive: true })
  const runTaskboard = async (...args: string[]): Promise<Record<string, unknown>> => {
    const result = await run(python, ['-I', '-B', taskboard, '--board', board, '--json', ...args], options)
    let envelope: unknown
    try { envelope = JSON.parse(result.stdout) } catch { throw new Error('desktop runtime: expert taskboard returned invalid JSON') }
    if (typeof envelope !== 'object' || envelope === null || !('ok' in envelope) || envelope.ok !== true) {
      throw new Error('desktop runtime: expert taskboard smoke command failed')
    }
    return envelope as Record<string, unknown>
  }

  const created = await runTaskboard('create', 'desktop packaged smoke', '--desc', 'Bundled Python taskboard acceptance')
  if (created.cmd !== 'create') throw new Error('desktop runtime: expert taskboard did not create its smoke task')
  const listed = await runTaskboard('list')
  const data = listed.data
  const tasks = typeof data === 'object' && data !== null && 'tasks' in data ? data.tasks : undefined
  if (listed.cmd !== 'list' || !Array.isArray(tasks)
    || !tasks.some(task => typeof task === 'object' && task !== null && 'title' in task && task.title === 'desktop packaged smoke')) {
    throw new Error('desktop runtime: expert taskboard could not read its smoke task')
  }
  await run(python, ['-I', '-B', bus, '--root', join(cwd, '.expert-bus'),
    'send', '--from', 'desktop-smoke', '--to', 'coordinator', '--subject', 'desktop runtime smoke',
    '--body', 'bundled Python message bus smoke'], options)
  const received = await run(python, ['-I', '-B', bus, '--root', join(cwd, '.expert-bus'),
    'read', '--box', 'coordinator', '--all-boxes'], options)
  if (!received.stdout.includes('bundled Python message bus smoke')) {
    throw new Error('desktop runtime: expert message bus could not read its smoke message')
  }
  console.log('desktop runtime: bundled expert taskboard and message bus operations passed')
}
