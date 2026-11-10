#!/usr/bin/env node
/** Launch the desktop development shells: the packaged-free Electron window or the hot-rebuilding web loop. */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DESKTOP = join(ROOT, 'apps', 'desktop')

/** Development modes this launcher can start. */
const MODES = {
  electron: {
    label: 'Electron 开发模式',
    args: ['--filter', '@deepseek-ai/dsh-desktop', 'run', 'dev'],
    notes: [
      '会用符号链接把当前工作区的包直接接进开发工程,改包不用重新打包。',
      '启动后自动打开 DevTools;inspector 端口 main=9229 renderer=9222 host=9230。',
      '宿主侧代码改动需要 Ctrl+C 后重跑;渲染层在 DevTools 里调试。',
    ],
  },
  web: {
    label: '浏览器热更新模式',
    args: ['run', 'dev:web'],
    notes: [
      '同时跑 tsc --watch、tsdown watch、vite build --watch,再启动 dsh web。',
      '浏览器里改代码会自动重建并刷新页面。',
      '不要和 pnpm build / build:artifacts 同时运行,它们会抢同一批 lib/ 产物。',
    ],
  },
}

function usage() {
  console.log(`用法: node scripts/dev-mode.mjs [模式] [选项]

模式:
  --electron   Electron 开发模式(默认)
  --web        浏览器热更新模式

选项:
  --skip-build 复用已有构建产物,跳过开头的一次性构建
  --help       显示本帮助

等价命令:
  Electron: pnpm --filter @deepseek-ai/dsh-desktop run dev [--skip-build]
  热更新:   pnpm run dev:web [--skip-build]`)
}

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) { usage(); process.exit(0) }

let mode = 'electron'
const passthrough = []
for (const argument of argv) {
  if (argument === '--web') mode = 'web'
  else if (argument === '--electron') mode = 'electron'
  else if (argument === '--skip-build') passthrough.push('--skip-build')
  else { console.error(`未知参数: ${argument}`); usage(); process.exit(2) }
}

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 19) || nodeMajor === 23) {
  console.error(`当前 Node ${process.versions.node} 低于仓库要求的 ^22.19.0 || >=24。`)
  console.error('旧版 Node 没有 import.meta.main,build:artifacts 会静默跳过,新包不会被构建。请先升级 Node 再运行。')
  process.exit(1)
}

if (!existsSync(join(DESKTOP, 'package.json'))) {
  console.error(`找不到桌面端目录: ${DESKTOP}`)
  process.exit(1)
}

const selected = MODES[mode]
console.log(`${selected.label}`)
for (const note of selected.notes) console.log(`  - ${note}`)
console.log('  Ctrl+C 结束。\n')

/** Prepared Electron distribution, reused so development never downloads a second copy. */
const preparedElectron = join(DESKTOP, '.desktop-build', 'targets', 'win-x64', 'electron')
const environment = { ...process.env }
if (mode === 'electron' && existsSync(join(preparedElectron, 'electron.exe'))) {
  environment.ELECTRON_OVERRIDE_DIST_PATH = preparedElectron
  console.log(`  复用已准备的 Electron: ${preparedElectron}\n`)
}

const command = [...selected.args, ...passthrough]
const child = spawn('pnpm', command, { cwd: ROOT, shell: true, stdio: 'inherit', env: environment })

child.on('error', error => {
  console.error(`无法启动开发模式: ${error.message}`)
  process.exit(1)
})

child.on('exit', code => {
  process.exit(code ?? 1)
})

process.on('SIGINT', () => {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGINT')
  process.exit(130)
})
