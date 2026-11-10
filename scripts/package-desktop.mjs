#!/usr/bin/env node
/** One-click desktop packaging with a live progress bar driven by the packaging journal. */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, createWriteStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DESKTOP = join(ROOT, 'apps', 'desktop')
const RUNS_ROOT = join(DESKTOP, '.desktop-build', 'packaging-runs')
const LOG_FILE = join(DESKTOP, '.desktop-build', 'package-desktop.log')
/** Local tarball cache that lets unchanged packages skip their pack run. */
const PACK_CACHE = join(DESKTOP, '.desktop-build', 'pack-cache')

/** Selectable package targets; `script` is the root package.json entry that runs them. */
const TARGETS = {
  'win-x64-unsigned': {
    label: 'Windows x64 安装包(免签名)',
    script: 'package:desktop:win:x64:unsigned',
    artifacts: ['unsigned-artifacts'],
  },
  'win-x64-dir': {
    label: 'Windows x64 免安装目录(需签名证书)',
    script: 'package:desktop:win:x64:dir',
    artifacts: ['dir-artifacts', 'unsigned-artifacts'],
  },
  'win-x64-signed': {
    label: 'Windows x64 安装包(签名)',
    script: 'package:desktop:win:x64',
    artifacts: ['artifacts', 'unsigned-artifacts'],
  },
}

/**
 * Expected packaging phases in execution order with reference duration in seconds.
 * Weights only shape the progress bar; a phase that never runs simply never counts.
 */
const PHASES = [
  ['configuration', 1],
  ['toolchain', 1],
  ['run build:official', 3],
  ['run release:pack --family dsh', 1112],
  ['--dir apps/desktop-host pack', 4],
  ['run release:pack --family vendor', 28],
  ['--dir native/system run build:ts', 4],
  ['--dir native/system/packages/entry pack', 2],
  ['download:electron', 15],
  ['extract:electron', 4],
  ['prepare:primary-runtime', 92],
  ['prepare:cli', 1],
  ['run prepare:packages', 2],
  ['runtime:reset', 14],
  ['runtime:stage-packages', 1],
  ['runtime:lockfile', 20],
  ['runtime:install', 63],
  ['runtime:materialize-modules', 46],
  ['runtime:manifests', 1],
  ['runtime:primary-smoke', 34],
  ['runtime:write-descriptor', 10],
  ['runtime:verify-before-smoke', 7],
  ['runtime:smoke', 42],
  ['runtime:verify-after-smoke', 4],
  ['runtime:cleanup', 38],
  ['exec electron-builder', 419],
  ['exec tsx scripts/smoke-packaged-runtime.ts', 56],
]

const TOTAL_WEIGHT = PHASES.reduce((sum, [, weight]) => sum + weight, 0)
const BAR_WIDTH = 28

/** Weight of a journal stage name, or undefined when the phase is not part of the plan. */
function phaseWeight(stage) {
  const match = PHASES.find(([name]) => stage === name || stage.startsWith(`${name} `))
  return match === undefined ? undefined : match[1]
}

/** Human readable short label for a journal stage name. */
function phaseLabel(stage) {
  return stage.length <= 46 ? stage : `${stage.slice(0, 43)}...`
}

/** Seconds as `m:ss`. */
function duration(seconds) {
  const whole = Math.max(0, Math.round(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/** Render one progress line. */
function renderBar(fraction, elapsed, stage, done, total) {
  const filled = Math.min(BAR_WIDTH, Math.round(fraction * BAR_WIDTH))
  const bar = `${'#'.repeat(filled)}${'-'.repeat(BAR_WIDTH - filled)}`
  const percent = String(Math.min(99, Math.floor(fraction * 100))).padStart(2, ' ')
  return `[${bar}] ${percent}%  ${duration(elapsed)}  ${stage === undefined ? '准备中' : phaseLabel(stage)}  (${done}/${total})`
}

/** Newest packaging run directory created after the build started. */
function latestRunDirectory(startedAt) {
  if (!existsSync(RUNS_ROOT)) return undefined
  let newest
  let newestTime = startedAt - 5000
  for (const name of readdirSync(RUNS_ROOT)) {
    const directory = join(RUNS_ROOT, name)
    let modified
    try { modified = statSync(directory).mtimeMs } catch { continue }
    if (modified > newestTime) { newest = directory; newestTime = modified }
  }
  return newest
}

/** Read journal events, tolerating a partially written trailing line. */
function readEvents(directory) {
  const file = join(directory, 'events.jsonl')
  if (!existsSync(file)) return []
  const events = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    if (line === '') continue
    try { events.push(JSON.parse(line)) } catch { /* trailing partial write */ }
  }
  return events
}

/** Accumulate completed phase weight and the currently running phase. */
function measure(events) {
  const open = new Map()
  const completed = []
  for (const event of events) {
    if (event.type === 'stage-start') {
      open.set(event.stageId, { stage: event.stage, at: Date.parse(event.time) })
    } else if (event.type === 'stage-end') {
      const entry = open.get(event.stageId)
      if (entry !== undefined && phaseWeight(entry.stage) !== undefined) {
        completed.push({ stage: entry.stage, seconds: (event.elapsedMs ?? 0) / 1000 })
      }
      open.delete(event.stageId)
    }
  }
  return { completed, running: [...open.values()].at(-1) }
}

/** Locate the installers produced by this run. */
function collectArtifacts(target, since) {
  const root = join(DESKTOP, '.desktop-build', 'targets', 'win-x64')
  const found = []
  for (const folder of target.artifacts) {
    const directory = join(root, folder)
    if (!existsSync(directory)) continue
    for (const name of readdirSync(directory)) {
      if (!/\.(?:exe|blockmap)$/u.test(name)) continue
      const path = join(directory, name)
      const stats = statSync(path)
      if (stats.isFile() && stats.size > 1024 && stats.mtimeMs >= since) {
        found.push({ path, megabytes: stats.size / 1024 / 1024 })
      }
    }
  }
  return found.sort((left, right) => right.megabytes - left.megabytes).slice(0, 4)
}

function usage() {
  console.log(`用法: node scripts/package-desktop.mjs [目标] [选项]

目标:
${Object.entries(TARGETS).map(([name, target]) => `  --target=${name}  ${target.label}`).join('\n')}

选项:
  --dir       等价于 --target=win-x64-dir
  --signed    等价于 --target=win-x64-signed
  --unsigned  等价于 --target=win-x64-unsigned(默认)
  --no-cache  本次不复用包缓存(全量重打)并把已有缓存当脏数据忽略
  --help      显示本帮助`)
}

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) { usage(); process.exit(0) }

let targetName = 'win-x64-unsigned'
let useCache = true
for (const argument of argv) {
  if (argument === '--dir') targetName = 'win-x64-dir'
  else if (argument === '--signed') targetName = 'win-x64-signed'
  else if (argument === '--unsigned') targetName = 'win-x64-unsigned'
  else if (argument === '--no-cache') useCache = false
  else if (argument.startsWith('--target=')) targetName = argument.slice('--target='.length)
  else { console.error(`未知参数: ${argument}`); usage(); process.exit(2) }
}
const target = TARGETS[targetName]
if (target === undefined) { console.error(`未知目标: ${targetName}`); usage(); process.exit(2) }

const settingsFile = join(DESKTOP, '.env.windows')
if (!existsSync(settingsFile)) {
  copyFileSync(join(DESKTOP, '.env.windows.example'), settingsFile)
  console.error(`已生成 ${settingsFile},请填写发布配置后重新运行。`)
  process.exit(1)
}

mkdirSync(dirname(LOG_FILE), { recursive: true })
const log = createWriteStream(LOG_FILE, { flags: 'w' })
console.log(`一键打包: ${target.label}`)
console.log(`日志: ${LOG_FILE}\n`)

const startedAt = Date.now()
const child = spawn('pnpm', ['run', target.script], {
  cwd: ROOT,
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: useCache ? { ...process.env, DSH_PACK_CACHE: PACK_CACHE } : process.env,
})

const pump = stream => stream.on('data', chunk => log.write(chunk))
pump(child.stdout)
pump(child.stderr)

const finished = []
let stageDirectory
let lastRendered = ''
const timer = setInterval(() => {
  stageDirectory ??= latestRunDirectory(startedAt)
  if (stageDirectory === undefined) return
  const { completed, running } = measure(readEvents(stageDirectory))
  for (const entry of completed) {
    if (finished.some(seen => seen.stage === entry.stage)) continue
    finished.push(entry)
    process.stdout.write(`\r\x1b[K  ok  ${phaseLabel(entry.stage)}  (${duration(entry.seconds)})\n`)
  }
  const done = finished.reduce((sum, entry) => sum + (phaseWeight(entry.stage) ?? 0), 0)
  const weight = running === undefined ? 0 : phaseWeight(running.stage) ?? 0
  const elapsedInPhase = running === undefined ? 0 : (Date.now() - running.at) / 1000
  // Approach the phase weight asymptotically so a long phase keeps the bar moving instead of stalling.
  const current = weight === 0 ? 0 : weight * (1 - Math.exp(-elapsedInPhase / (weight * 0.55)))
  const fraction = Math.min(0.99, (done + current) / TOTAL_WEIGHT)
  const line = renderBar(fraction, (Date.now() - startedAt) / 1000, running?.stage, finished.length, PHASES.length)
  if (line !== lastRendered) { process.stdout.write(`\r\x1b[K${line}`); lastRendered = line }
}, 700)

child.on('error', error => {
  clearInterval(timer)
  process.stdout.write('\n')
  console.error(`无法启动打包进程: ${error.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  clearInterval(timer)
  log.end()
  process.stdout.write('\r\x1b[K')
  const elapsed = (Date.now() - startedAt) / 1000
  if (code === 0) {
    console.log(`[############################] 100%  ${duration(elapsed)}  打包完成\n`)
    for (const artifact of collectArtifacts(target, startedAt)) {
      console.log(`  ${artifact.path}`)
      console.log(`    ${artifact.megabytes.toFixed(1)} MB`)
    }
  } else {
    console.log(`打包失败 (${signal ?? `退出码 ${String(code)}`}),用时 ${duration(elapsed)}。`)
    console.log(`查看日志: ${LOG_FILE}`)
  }
  process.exit(code ?? 1)
})

/** Stop the packaging child and its whole process tree. */
function stopChild() {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  child.kill('SIGINT')
}

process.on('SIGINT', () => {
  clearInterval(timer)
  stopChild()
  console.log('\n已取消。')
  process.exit(130)
})
