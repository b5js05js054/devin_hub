import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { afterEach, expect, it, vi } from 'vitest'

const bundle = '../bundled-plugins/bailan-expert-orchestrator/'
const { registerExpertTools } = await import(new URL(bundle + 'lib/tools.js', import.meta.url).href)
const taskboard = fileURLToPath(new URL(bundle + 'skills/expert-orchestration/tools/taskboard.py', import.meta.url))
const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

it('claims only the current workspace task and lists the experts available in that workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-workspaces-'))
  roots.push(root)
  const runtime = process.env.DSH_PRIMARY_RUNTIME ?? join(resolveDshHome(), 'dsh-runtimes', 'dsh-primary-runtime')
  const bundled = join(runtime, 'dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  const systemPython = process.platform === 'win32' ? 'python' : 'python3'
  const python = process.env.DSH_EXPERT_ORCHESTRATOR_PYTHON || (existsSync(bundled) ? bundled : systemPython)
  vi.stubEnv('DSH_EXPERT_ORCHESTRATOR_PYTHON', python)
  vi.stubEnv('DSH_HOME', root)
  vi.stubEnv('DSH_EXPERT_AUTOCLAIM', '1')
  vi.stubEnv('DSH_EXPERT_IDLE_RECLAIM', '0')
  const original = join(root, 'original')
  const current = join(root, 'current')
  const board = (cwd: string) => join(cwd, '.expert-taskboards', 'tasks.json')
  for (const cwd of [original, current]) {
    await mkdir(join(cwd, '.expert-taskboards'), { recursive: true })
    await promisify(execFile)(python, ['-I', '-B', taskboard, '--board', board(cwd), '--json', 'create', 'Review'])
  }
  await mkdir(join(current, '.dsh', 'experts'), { recursive: true })
  await writeFile(join(current, '.dsh', 'experts', 'reviewer.md'), '---\nname: workspace-reviewer\n---\nReview the request.\n')
  await mkdir(join(root, 'expert-sources', 'merged'), { recursive: true })
  await writeFile(join(root, 'expert-sources', 'merged', 'roster.json'), JSON.stringify({ core: [{ name: 'reviewer', file: 'reviewer.md' }] }))

  const session = { header: { cwd: original } }
  let cwd = current
  const exec = { agent: { session }, signal: new AbortController().signal }
  type TestTool = { name: string; execute: (args: object, context: typeof exec) => Promise<unknown> }
  const registered = new Map<string, TestTool>()
  const start = vi.fn(async () => ({ result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'reviewed' }] }) }))
  registerExpertTools({
    tools: { register: (tool: TestTool) => registered.set(tool.name, tool) },
    get: (service: string) => service === 'workingDirectory' ? { ensure: async () => cwd } : undefined,
    subagents: {
      getProvider: () => ({ capabilities: { persona: true, toolFilter: true } }),
      start,
    },
  }, { dst: root, autoClaim: true, getExpertContentImpl: () => ({ content: 'Review the task.' }) })

  const list = () => registered.get('list_experts')!.execute({}, exec)
  expect(await list()).toMatchObject({ total: 2 })
  const result = await registered.get('summon_expert')!.execute({ expert: 'reviewer', task: 'Review T1', readOnly: true }, exec)
  expect(result).toMatchObject({ answer: expect.stringContaining('reviewed') })
  expect(start).toHaveBeenCalledWith('spawn', expect.objectContaining({ cwd: current }))
  expect(JSON.parse(await readFile(board(current), 'utf8')).tasks.T1).toMatchObject({ status: 'running', owner: 'reviewer' })
  expect(JSON.parse(await readFile(board(original), 'utf8')).tasks.T1).toMatchObject({ status: 'ready', owner: '' })
  cwd = original
  expect(await list()).toMatchObject({ total: 1 })
})
