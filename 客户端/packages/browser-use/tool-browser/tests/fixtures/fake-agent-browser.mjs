// Scripted stand-in for the agent-browser CLI: `node fake-agent-browser.mjs <log-file> [cli arguments]`.
// It appends one JSON line per invocation to the log file and answers a
// `batch --json --bail` request from the first argument of each command.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'

const [logFile, ...argv] = process.argv.slice(2)

async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

const stdin = argv.includes('batch') ? await readStdin() : ''
appendFileSync(logFile, `${JSON.stringify({
  argv,
  cwd: process.cwd(),
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AGENT_BROWSER_'))),
  stdin,
})}\n`)

if (!argv.includes('batch')) {
  if (process.env.FAKE_BROWSER_CLOSE === 'fail') {
    process.stderr.write('close failed')
    process.exit(1)
  }
  process.stdout.write('closed')
  process.exit(0)
}

const lifecycle = { launched: false, relaunchedBrowser: false, reused: true }
const rows = []
let failed = false
for (const command of JSON.parse(stdin)) {
  const [name, ...rest] = command
  switch (name) {
    case 'raw':
      process.stdout.write(rest[0])
      process.exit(0)
      break
    case 'silent':
      process.stderr.write(rest[1] ?? '')
      process.exit(Number(rest[0]))
      break
    case 'flood':
      process.stdout.write('x'.repeat(Number(rest[0])))
      process.exit(0)
      break
    case 'hang':
      await new Promise(() => { setInterval(() => {}, 1_000) })
      break
    case 'badrow':
      process.stdout.write(JSON.stringify([{ command, success: 'yes' }]))
      process.exit(0)
      break
    case 'extra':
      rows.push({ command, success: true, error: null, result: null }, { command, success: true, error: null, result: null })
      break
    case 'fail':
      rows.push({ command, success: false, error: rest[0] ?? null, result: null })
      failed = true
      break
    case 'snapshot':
      rows.push({ command, success: true, error: null, result: { lifecycle, origin: 'https://example.test', refs: { e1: { name: 'Sign in', role: 'button' } }, snapshot: rest.includes('--empty') ? '' : '- button "Sign in" [ref=e1]' } })
      break
    case 'relaunch':
      rows.push({ command, success: true, error: null, result: { lifecycle: { ...lifecycle, relaunchedBrowser: true }, url: 'about:blank' } })
      break
    case 'screenshot':
      writeFileSync(rest[0] ?? 'shot.png', 'png')
      rows.push({ command, success: true, error: null, result: { lifecycle, path: rest[0] ?? 'shot.png' } })
      break
    case 'save':
      // Like a click-started download: the browser names and writes the file, and the result does not mention it.
      for (const file of rest) writeFileSync(file, 'saved')
      rows.push({ command, success: true, error: null, result: { lifecycle, clicked: '#download' } })
      break
    case 'folder':
      mkdirSync(rest[0])
      rows.push({ command, success: true, error: null, result: { lifecycle } })
      break
    case 'annotated':
      rows.push({ command, success: true, error: null, result: { lifecycle, annotations: [{ box: { x: 1, y: 2, width: 3, height: 4 }, name: 'Sign in', number: 1, ref: 'e1', role: 'button' }, 'unlabelled'], path: 'marked.png' } })
      break
    case 'scalar':
      rows.push({ command, success: true, error: null, result: 42 })
      break
    case 'nothing':
      rows.push({ command, success: true, error: null })
      break
    default:
      rows.push({ command, success: true, error: null, result: { lifecycle, targetId: 'T1', echoed: rest } })
  }
  if (failed) break
}
process.stdout.write(JSON.stringify(rows))
process.exit(failed ? 1 : 0)
