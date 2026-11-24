import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const built = ['lib/index.js', 'lib/worker.cjs']
  .every(path => existsSync(join(packageRoot, path)))

describe.skipIf(!built)('built migration verifier (plain node)', () => {
  it('resumes V3 history with the Worker path accepted by the single-file runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-built-v3-resume-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const id = 'v3-resume'
    const directory = join(root, '_no-cwd', id)
    const source = join(directory, 'session.v3.jsonl')
    const current = join(directory, `session.v${SESSION_FORMAT_VERSION}.jsonl`)
    const message = {
      id: 'saved-message', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'Saved V3 history' }],
    }
    const rows = [
      { type: 'session', version: 3, id, createdAt: 1, isSeeded: false, delegationDepth: 0 },
      { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 11, data: message, surfaceOp: 'append' },
      { type: 'turn/end', seq: 2, time: 12, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const original = Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join(''))
    await mkdir(directory, { recursive: true })
    await writeFile(source, original)

    const script = `
      import { ok } from 'node:assert/strict'
      import { syncBuiltinESMExports } from 'node:module'
      import { isAbsolute } from 'node:path'
      import threads from 'node:worker_threads'
      import { Context } from '@deepseek-ai/cordis'
      // The packaged runtime mounts its embedded filesystem only for string Worker entries.
      threads.Worker = class extends threads.Worker {
        constructor(entry, options) {
          ok(typeof entry === 'string' && isAbsolute(entry), 'expected an absolute Worker path string')
          super(entry, options)
        }
      }
      syncBuiltinESMExports()
      const backend = await import('@deepseek-ai/dsh-session-persistence-jsonl')
      const ctx = new Context()
      try {
        await ctx.plugin(backend, { root: process.argv[1], compression: 'none' })
        const handle = await ctx.sessionPersistence.open(process.argv[2], 'write')
        try {
          const { events } = await handle.read()
          console.log(JSON.stringify(events.find(event => event.type === 'user/message')?.data))
        } finally { await handle.close() }
      } finally { await ctx.fiber.dispose() }
    `
    async function resume() {
      const { stdout } = await execa(process.execPath, ['--input-type=module', '-e', script, root, id], {
        cwd: packageRoot, env: { NODE_PATH: undefined, NODE_OPTIONS: undefined },
        stdin: 'ignore', timeout: 30_000, killSignal: 'SIGKILL',
      })
      expect(JSON.parse(stdout)).toEqual(message)
    }
    await resume()
    const published = await readFile(current)
    await resume()
    expect(await readFile(current)).toEqual(published)
    expect(await readFile(source)).toEqual(original)
  })

  it('publishes history and verifies it without runtime workspace imports', async () => {
    const script = `
      import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
      import { tmpdir } from 'node:os'
      import { join } from 'node:path'
      import { Worker } from 'node:worker_threads'
      import { Context } from '@deepseek-ai/cordis'
      import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
      import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

      const terminate = Worker.prototype.terminate
      let terminations = 0
      Worker.prototype.terminate = function () {
        terminations += 1
        return terminate.call(this)
      }
      const root = await mkdtemp(join(tmpdir(), 'dsh-built-migration-'))
      const id = 'built-migration-worker'
      const directory = join(root, '_no-cwd', id)
      const ctx = new Context()
      try {
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'session.jsonl'), JSON.stringify({
          type: 'session', version: 0, id, createdAt: 1, delegationDepth: 0,
        }) + '\\n')
        await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
        const handle = await ctx.sessionPersistence.open(id, 'write')
        await handle.close()
        await ctx.sessionPersistence.flush()
        const currentPath = join(directory, 'session.v' + SESSION_FORMAT_VERSION + '.jsonl')
        const header = JSON.parse((await readFile(currentPath, 'utf8')).trim())
        await mkdir(join(root, 'lib'))
        await copyFile('package.json', join(root, 'package.json'))
        const workerPath = join(root, 'lib', 'worker.cjs')
        await copyFile('lib/worker.cjs', workerPath)
        async function verify(expectedEventCount) {
          const worker = new Worker(workerPath, { workerData: {
            path: currentPath, compression: 'none', expectedId: id, expectedEventCount,
          } })
          try {
            return await new Promise((resolve, reject) => {
              let response
              worker.once('message', value => { response = value })
              worker.once('error', reject)
              worker.once('exit', code => {
                if (code === 0 && response !== undefined) resolve(response)
                else reject(new Error('verifier did not complete: ' + code))
              })
            })
          } finally {
            if (worker.threadId !== -1) await worker.terminate()
          }
        }
        const verified = await verify(0)
        const refused = await verify(1)
        console.log(JSON.stringify({ id: header.id, version: header.version,
          verified: verified.ok, refused: refused.ok, refusal: refused.message, terminations }))
      } finally {
        await ctx.fiber.dispose()
        await rm(root, { recursive: true, force: true })
      }
    `
    const { exitCode, stdout, stderr, timedOut, signal } = await execa(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: packageRoot, env: { NODE_PATH: undefined, NODE_OPTIONS: undefined },
        stdin: 'ignore', timeout: 30_000, killSignal: 'SIGKILL', reject: false,
      },
    )

    expect(timedOut).toBe(false)
    expect(signal).toBeUndefined()
    expect(exitCode, `stderr:\n${stderr}`).toBe(0)
    expect(JSON.parse(stdout.trim())).toEqual({
      id: 'built-migration-worker', version: SESSION_FORMAT_VERSION, verified: true, refused: false,
      refusal: 'current session generation contains 0 events, expected 1', terminations: 0,
    })
  })
})
