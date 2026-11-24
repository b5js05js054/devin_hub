import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
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
let announcementPayload: unknown = null
let dir = ''
let ctx: Context
const fibers: Array<{ dispose(): Promise<unknown> }> = []
const previousHome = process.env.DSH_HOME

beforeEach(async () => {
  meStatus = 200
  updatePayload = null
  announcementPayload = null
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
      } else if (req.url === '/api/user/oauth/token') {
        if (JSON.parse(lastBody).code === 'issued-once') res.end(session)
        else { res.statusCode = 400; res.end(JSON.stringify({ detail: 'invalid code' })) }
      } else if (req.url === '/api/user/login' || req.url === '/api/user/register') {
        res.end(session)
      } else if (req.url === '/api/license/client-config') {
        res.end(JSON.stringify({ ok: true, update: updatePayload, announcement: announcementPayload }))
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

async function browserAttempt() {
  const view = await ctx.relayAccount.startSignIn()
  const authorize = new URL(view.signIn.authorizeUrl!)
  const callback = new URL(authorize.searchParams.get('redirect_uri')!)
  callback.searchParams.set('state', authorize.searchParams.get('state')!)
  callback.searchParams.set('code', 'issued-once')
  return { authorize, callback }
}

describe('relay account', () => {
  it('publishes the configured account center only to the signed-in view', async () => {
    const view = await ctx.relayAccount.login('a@b.co', 'pw')
    expect(view).toHaveProperty('accountCenterUrl', `${origin}/account`)
    await ctx.relayAccount.logout()
    expect(await ctx.relayAccount.getState()).not.toHaveProperty('accountCenterUrl')
  })

  it('rejects unrelated callbacks, then exchanges the PKCE code before directing the browser to the account center', async () => {
    const { authorize, callback } = await browserAttempt()
    expect(authorize.origin + authorize.pathname).toBe(`${origin}/account`)
    expect(callback.hostname).toBe('127.0.0.1')
    expect(callback.pathname).toBe('/callback')
    const wrongPath = new URL(callback)
    wrongPath.pathname = '/other'
    const missingCode = new URL(callback)
    missingCode.searchParams.delete('code')
    const wrongState = new URL(callback)
    const state = callback.searchParams.get('state')!
    wrongState.searchParams.set('state', (state.startsWith('x') ? 'y' : 'x') + state.slice(1))
    for (const invalid of [wrongPath, missingCode, wrongState]) {
      const response = await fetch(invalid, { redirect: 'manual' })
      expect(response.status).toBe(400)
      expect(response.headers.get('location')).toBeNull()
    }
    expect((await fetch(callback, { method: 'POST', redirect: 'manual' })).status).toBe(400)
    expect((await ctx.relayAccount.getState()).signIn.phase).toBe('waiting-browser')

    const response = await fetch(callback, { redirect: 'manual' })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(`${origin}/account`)
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await ctx.relayAccount.getToken()).toBe('tok-1')
    const exchange = JSON.parse(lastBody) as { code: string; code_verifier: string; redirect_uri: string }
    expect(exchange.code).toBe('issued-once')
    expect(exchange.redirect_uri).toBe(authorize.searchParams.get('redirect_uri'))
    expect(createHash('sha256').update(exchange.code_verifier).digest('base64url')).toBe(authorize.searchParams.get('code_challenge'))
  })

  it('reports a rejected exchange to the browser and desktop without navigating to the account center', async () => {
    const { callback } = await browserAttempt()
    callback.searchParams.set('code', 'expired-code')
    const response = await fetch(callback, { redirect: 'manual' })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.headers.get('location')).toBeNull()
    expect(await response.text()).toContain('请返回客户端重试')
    expect(await ctx.relayAccount.getState()).toMatchObject({ status: 'signed-out', signIn: { phase: 'failed', code: 'rejected' } })
    expect(await ctx.relayAccount.getToken()).toBeUndefined()
  })

  it('closes a cancelled listener and leaves the desktop signed out', async () => {
    const { callback } = await browserAttempt()
    ctx.relayAccount.cancelSignIn()
    await expect(fetch(callback, { redirect: 'manual' })).rejects.toThrow()
    expect(await ctx.relayAccount.getState()).toMatchObject({ status: 'signed-out', signIn: { phase: 'idle' } })
  })

  it('claims one callback and honors cancellation while the credential write is queued', async () => {
    const { callback } = await browserAttempt()
    const writeQueued = Promise.withResolvers<void>()
    const allowWrite = Promise.withResolvers<void>()
    const write = ctx.credentials.modifyRecord.bind(ctx.credentials)
    vi.spyOn(ctx.credentials, 'modifyRecord').mockImplementationOnce(async (key, mutate) => {
      writeQueued.resolve()
      await allowWrite.promise
      return write(key, mutate)
    })
    const browser = fetch(callback, { redirect: 'manual' })
    try {
      await writeQueued.promise
      const duplicate = await fetch(callback, { redirect: 'manual' })
      expect(duplicate.status).toBe(400)
      expect(duplicate.headers.get('location')).toBeNull()
      ctx.relayAccount.cancelSignIn()
    } finally { allowWrite.resolve() }
    const response = await browser
    expect(response.headers.get('location')).toBeNull()
    expect(response.status).toBeGreaterThanOrEqual(400)
    await vi.waitFor(async () => { expect((await ctx.relayAccount.getState()).signIn.phase).toBe('idle') })
    expect(await ctx.relayAccount.getToken()).toBeUndefined()
  })

  it('keeps the browser on a failure result when the exchanged grant cannot be saved', async () => {
    const { callback } = await browserAttempt()
    vi.spyOn(ctx.credentials, 'modifyRecord').mockRejectedValueOnce(new Error('credential write failed'))
    const response = await fetch(callback, { redirect: 'manual' })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.headers.get('location')).toBeNull()
    expect(await ctx.relayAccount.getState()).toMatchObject({ status: 'signed-out', signIn: { phase: 'failed', code: 'storage' } })
  })

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

  it('reads the announcement the operator published', async () => {
    await ctx.relayAccount.login('a@b.co', 'pw')
    announcementPayload = { enabled: true, title: '公告', content: '第一行\n第二行', level: 'error' }
    expect(await ctx.relayAccount.readAnnouncement()).toEqual({ title: '公告', content: '第一行\n第二行', level: 'error' })
  })

  it('reports no announcement when none is published, it is disabled, or it has no content', async () => {
    await ctx.relayAccount.login('a@b.co', 'pw')
    expect(await ctx.relayAccount.readAnnouncement()).toBeNull()
    announcementPayload = { enabled: false, title: 't', content: 'c', level: 'info' }
    expect(await ctx.relayAccount.readAnnouncement()).toBeNull()
    announcementPayload = { enabled: true, title: 't', content: '  \n ', level: 'info' }
    expect(await ctx.relayAccount.readAnnouncement()).toBeNull()
  })

  it('shows an announcement of an unknown level as an ordinary one and rejects a malformed one', async () => {
    await ctx.relayAccount.login('a@b.co', 'pw')
    announcementPayload = { enabled: true, content: 'c', level: 'critical' }
    expect(await ctx.relayAccount.readAnnouncement()).toEqual({ title: '', content: 'c', level: 'info' })
    announcementPayload = 'maintenance'
    await expect(ctx.relayAccount.readAnnouncement()).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('keeps release checks working when the announcement is malformed', async () => {
    await ctx.relayAccount.login('a@b.co', 'pw')
    announcementPayload = 'maintenance'
    expect(await ctx.relayAccount.checkUpdate()).toBeNull()
  })

  it('refuses to read the announcement while signed out', async () => {
    await expect(ctx.relayAccount.readAnnouncement()).rejects.toMatchObject({ code: 'signed-out' })
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
