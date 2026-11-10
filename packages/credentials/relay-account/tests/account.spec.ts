import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import RelayAccount, { RelayAccountError, sniffImage } from '../src/index.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const user = { id: 7, email: 'a@b.co', avatar_url: '/api/user/files/' + 'a'.repeat(32) + '.png' }

let server: Server
let origin = ''
let lastBody = ''
let meStatus = 200
let updatePayload: unknown = null
let dir = ''
let ctx: Context
const fibers: Array<{ dispose(): Promise<unknown> }> = []
const previousHome = process.env.DSH_HOME

beforeEach(async () => {
  meStatus = 200
  updatePayload = null
  dir = await mkdtemp(join(tmpdir(), 'dsh-relay-account-'))
  process.env.DSH_HOME = dir
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('latin1')
      res.setHeader('content-type', 'application/json')
      const session = JSON.stringify({ ok: true, token: 'tok-1', expires_at: new Date(Date.now() + 3_600_000).toISOString(), user })
      if (req.url === '/api/user/login' && lastBody.includes('wrong')) {
        res.statusCode = 400
        res.end(JSON.stringify({ detail: '邮箱或密码错误' }))
      } else if (req.url === '/api/user/login' || req.url === '/api/user/register') {
        res.end(session)
      } else if (req.url === '/api/license/client-config') {
        res.end(JSON.stringify({ ok: true, update: updatePayload }))
      } else if (req.url === '/api/user/me') {
        res.statusCode = meStatus
        res.end(meStatus === 200 ? JSON.stringify({ user }) : JSON.stringify({ detail: '登录已失效，请重新登录' }))
      } else {
        res.statusCode = 404
        res.end('{}')
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`
  ctx = new Context()
  const store = ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await store
  const account = ctx.plugin(RelayAccount, { apiOrigin: origin, allowLoopbackHttp: true })
  await account
  fibers.push(account, store)
})

afterEach(async () => {
  while (fibers.length > 0) await fibers.pop()!.dispose()
  await new Promise<void>(resolve => server.close(() => { resolve() }))
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(dir, { recursive: true, force: true })
})

describe('relay account', () => {
  it('logs in, exposes the profile without the token, and hands the token to the Host', async () => {
    const view = await ctx.relayAccount.login(' a@b.co ', 'pw')
    expect(view.status).toBe('signed-in')
    expect(view.profile).toEqual({ id: 7, email: 'a@b.co', avatarUrl: `${origin}/api/user/files/${'a'.repeat(32)}.png` })
    expect(JSON.stringify(view)).not.toContain('tok-1')
    expect(await ctx.relayAccount.getToken()).toBe('tok-1')
    expect(lastBody).toContain('"email":"a@b.co"')
  })

  it('reads the published release for this platform', async () => {
    await ctx.relayAccount.login('a@b.co', 'pw')
    updatePayload = {
      enabled: true, version: '1.2.3', url: 'https://x/win.exe', sha256: 'AB'.repeat(32),
      url_macos: 'https://x/mac.dmg', sha256_macos: 'CD'.repeat(32), mandatory: true, note: 'fixes',
    }
    const mac = process.platform === 'darwin'
    expect(await ctx.relayAccount.checkUpdate()).toEqual({
      version: '1.2.3', url: mac ? 'https://x/mac.dmg' : 'https://x/win.exe',
      sha256: (mac ? 'cd' : 'ab').repeat(32), mandatory: true, note: 'fixes',
    })
  })

  it('reports no release when none is enabled', async () => {
    await ctx.relayAccount.login('a@b.co', 'pw')
    expect(await ctx.relayAccount.checkUpdate()).toBeNull()
    updatePayload = { enabled: false, version: '2.0.0', url: 'https://x/win.exe' }
    expect(await ctx.relayAccount.checkUpdate()).toBeNull()
  })

  it('refuses to check for a release while signed out', async () => {
    await expect(ctx.relayAccount.checkUpdate()).rejects.toMatchObject({ code: 'signed-out' })
  })

  it('surfaces the backend detail on rejection and stays signed out', async () => {
    await expect(ctx.relayAccount.login('a@b.co', 'wrong')).rejects.toMatchObject({ code: 'rejected', message: '邮箱或密码错误' })
    expect((await ctx.relayAccount.getState()).status).toBe('signed-out')
  })

  it('registers with an avatar as multipart and reports finished progress', async () => {
    const view = await ctx.relayAccount.register('a@b.co', 'pw', { bytes: PNG, filename: 'C:\\x\\me.png' })
    expect(view.status).toBe('signed-in')
    expect(view.upload.phase).toBe('done')
    expect(view.upload.sent).toBe(view.upload.total)
  })

  it('rejects a non-image avatar before any request', async () => {
    await expect(ctx.relayAccount.register('a@b.co', 'pw', { bytes: new Uint8Array([1, 2, 3]), filename: 'x.png' }))
      .rejects.toMatchObject({ code: 'invalid-image' })
  })

  it('signs out locally when the backend says the session is invalid', async () => {
    await ctx.relayAccount.login('a@b.co', 'pw')
    meStatus = 401
    expect((await ctx.relayAccount.refresh()).status).toBe('signed-out')
    expect(await ctx.relayAccount.getToken()).toBeUndefined()
  })

  it('stores, reads, and clears the background per user', async () => {
    await expect(ctx.relayAccount.setBackground(PNG)).rejects.toBeInstanceOf(RelayAccountError)
    await ctx.relayAccount.login('a@b.co', 'pw')
    await ctx.relayAccount.setBackground(PNG)
    expect((await ctx.relayAccount.getState()).hasBackground).toBe(true)
    expect((await ctx.relayAccount.readBackground())?.mime).toBe('image/png')
    await ctx.relayAccount.clearBackground()
    expect((await ctx.relayAccount.getState()).hasBackground).toBe(false)
  })

  it('logout removes the session', async () => {
    await ctx.relayAccount.login('a@b.co', 'pw')
    await ctx.relayAccount.logout()
    expect((await ctx.relayAccount.getState()).status).toBe('signed-out')
  })

  it('sniffs image types by content', () => {
    expect(sniffImage(PNG)?.ext).toBe('png')
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0]))?.ext).toBe('jpg')
    expect(sniffImage(new Uint8Array([1, 2, 3]))).toBeUndefined()
  })
})
