import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFile } from 'node:fs/promises'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import RelayAccount from '@deepseek-ai/dsh-relay-account'
import RelayLicense, { maskCardKey } from '../src/index.ts'

const user = { id: 1, email: 'a@b.co', avatar_url: null }
interface Seen { url: string; auth: string | undefined; body: string }

let server: Server
let dir = ''
let seen: Seen[] = []
let heartbeatOk = true
let restorable = false
let activeUser = user
let holdActivation: (() => void) | undefined
let activationStarted: (() => void) | undefined
let holdHeartbeat: (() => void) | undefined
let heartbeatStarted: (() => void) | undefined
let tokenTtlMs = 3_600_000
let usageStatus = 200
let ctx: Context
const fibers: Array<{ dispose(): Promise<unknown> }> = []
const previousHome = process.env.DSH_HOME

function license(): Record<string, unknown> {
  return {
    ok: true, token: `lic-${String(seen.length)}`, token_expires_at: new Date(Date.now() + tokenTtlMs).toISOString(),
    card_expires_at: null, duration_days: 30, message: 'ok', balance: 12.5, billing_enabled: true, currency: '¥',
  }
}

beforeEach(async () => {
  seen = []
  heartbeatOk = true
  restorable = false
  activeUser = user
  holdActivation = undefined
  activationStarted = undefined
  holdHeartbeat = undefined
  heartbeatStarted = undefined
  tokenTtlMs = 3_600_000
  usageStatus = 200
  dir = await mkdtemp(join(tmpdir(), 'dsh-relay-license-'))
  process.env.DSH_HOME = dir
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, body: Buffer.concat(chunks).toString() })
      res.setHeader('content-type', 'application/json')
      const url = req.url ?? ''
      if (url === '/api/user/login') {
        res.end(JSON.stringify({ ok: true, token: activeUser.id === 1 ? 'acct' : 'acct-2', expires_at: new Date(Date.now() + 3_600_000).toISOString(), user: activeUser }))
      } else if (url === '/api/license/activate') {
        const response = license()
        if (activationStarted !== undefined) {
          holdActivation = () => { res.end(JSON.stringify(response)) }
          activationStarted()
        } else res.end(JSON.stringify(response))
      } else if (url === '/api/license/restore') {
        res.end(JSON.stringify(restorable ? { ...license(), card_key: 'BOUND-KEY' } : { ok: false, message: 'none' }))
      } else if (url === '/api/license/heartbeat') {
        const response = heartbeatOk ? license() : { ok: false, message: 'revoked' }
        if (heartbeatStarted !== undefined) {
          holdHeartbeat = () => { res.end(JSON.stringify(response)) }
          heartbeatStarted()
        } else res.end(JSON.stringify(response))
      } else if (url === '/api/license/redeem') {
        res.end(JSON.stringify({ ...license(), balance: 99, message: 'topped up' }))
      } else if (url.startsWith('/api/license/usage')) {
        res.statusCode = usageStatus
        res.end(JSON.stringify(usageStatus === 200 ? { total: 3 } : { detail: 'Not Found' }))
      } else {
        res.statusCode = 404
        res.end('{}')
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`
  ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(dir).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins['test-credentials'] = LocalCredentialProvider
  ctx.loader.builtins['test-account'] = RelayAccount
  ctx.loader.builtins['test-license'] = RelayLicense
  const config = join(dir, 'cordis.yml')
  await writeFile(config, [
    "- name: 'cordis:test-credentials'",
    '  config:',
    `    path: ${JSON.stringify(join(dir, '.credentials.yaml'))}`,
    '    watch: false',
    "- name: 'cordis:test-account'",
    '  config:',
    `    apiOrigin: ${origin}`,
    '    allowLoopbackHttp: true',
    "- name: 'cordis:test-license'",
    '  config:',
    '    background: false',
    '    refreshCooldownMs: 0',
    '',
  ].join('\n'))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  fibers.push(ctx.fiber)
  // Account-session checks use a stable device input instead of a live OS registry query.
  await ctx.credentials.modifyRecord(credentialKey('relay-license', 'device'), () => Promise.resolve({
    kind: 'grant', payload: { id: '0123456789abcdef0123456789abcdef' },
  }))
})

afterEach(async () => {
  while (fibers.length > 0) await fibers.pop()!.dispose()
  await new Promise<void>(resolve => server.close(() => { resolve() }))
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(dir, { recursive: true, force: true })
})

describe('relay license', () => {
  it('requires a signed-in account before activating', async () => {
    expect(await ctx.relayLicense.activate('abcd-efgh')).toEqual({ ok: false, message: 'sign in first' })
    expect(seen).toHaveLength(0)
  })

  it('activates with the account token and uppercased key, masking the key in views', async () => {
    await ctx.relayAccount.login('a@b.co', 'pw')
    const outcome = await ctx.relayLicense.activate(' abcd-efgh-ijkl ')
    expect(outcome.ok).toBe(true)
    const request = seen.find(s => s.url === '/api/license/activate')!
    expect(request.auth).toBe('Bearer acct')
    expect(JSON.parse(request.body)).toMatchObject({ card_key: 'ABCD-EFGH-IJKL' })
    const view = await ctx.relayLicense.getState()
    expect(view).toMatchObject({ activated: true, valid: true, cardKey: 'ABCD****IJKL', balance: 12.5, currency: '¥' })
    expect(JSON.stringify(view)).not.toContain('lic-')
    expect(view.deviceId).toMatch(/^[0-9a-f]{32}$/)
  })

  it('restores a card key already bound to this device after signing in again', async () => {
    restorable = true
    await ctx.relayAccount.login('a@b.co', 'pw')
    await vi.waitFor(async () => { expect(await ctx.relayLicense.getState()).toMatchObject({ activated: true, valid: true, cardKey: 'BOUN****-KEY' }) })
    const request = seen.find(s => s.url === '/api/license/restore')!
    expect(request.auth).toBe('Bearer acct')
    expect(JSON.parse(request.body)).toEqual({ device_id: expect.stringMatching(/^[0-9a-f]{32}$/) })
  })

  it('stays unactivated when the backend has nothing to restore', async () => {
    await ctx.relayAccount.login('a@b.co', 'pw')
    await vi.waitFor(() => { expect(seen.some(s => s.url === '/api/license/restore')).toBe(true) })
    expect(await ctx.relayLicense.getState()).toMatchObject({ activated: false })
  })

  it('serves credentials from the stored token without a request while fresh', async () => {
    await ctx.relayAccount.login('a@b.co', 'pw')
    await ctx.relayLicense.activate('KEY12345')
    await new Promise(resolve => setTimeout(resolve, 50))
    const before = seen.length
    const creds = await ctx.relayLicense.getCredentials()
    expect(creds?.token).toMatch(/^lic-/)
    expect(creds?.cardKey).toBe('KEY12345')
    expect(seen).toHaveLength(before)
  })

  it('renews an expired token synchronously before returning credentials', async () => {
    tokenTtlMs = -1000
    await ctx.relayAccount.login('a@b.co', 'pw')
    await ctx.relayLicense.activate('KEY12345')
    tokenTtlMs = 3_600_000
    const creds = await ctx.relayLicense.getCredentials()
    expect(seen.some(s => s.url === '/api/license/heartbeat')).toBe(true)
    expect(creds?.token).toBeDefined()
  })

  it('never serves a signed-out account license, and honors explicit refusals after sign-in', async () => {
    await ctx.relayAccount.login('a@b.co', 'pw')
    await ctx.relayLicense.activate('KEY12345')
    await ctx.relayAccount.logout()
    expect(await ctx.relayLicense.refresh()).toBe(false)
    expect(await ctx.relayLicense.getCredentials()).toBeUndefined()
    expect(await ctx.relayLicense.getState()).toMatchObject({ activated: false, balance: 0 })
    await ctx.relayAccount.login('a@b.co', 'pw')
    heartbeatOk = false
    expect(await ctx.relayLicense.refresh()).toBe(false)
    expect(await ctx.relayLicense.getState()).toMatchObject({ activated: false, message: 'revoked' })
    expect(await ctx.relayLicense.getCredentials()).toBeUndefined()
  })

  it('redeems with the license token and updates the balance', async () => {
    await ctx.relayAccount.login('a@b.co', 'pw')
    await ctx.relayLicense.activate('KEY12345')
    expect(await ctx.relayLicense.redeem('top-1')).toEqual({ ok: true, message: 'topped up' })
    expect((await ctx.relayLicense.getState()).balance).toBe(99)
    expect(JSON.parse(seen.find(s => s.url === '/api/license/redeem')!.body)).toEqual({ topup_code: 'TOP-1' })
  })

  it('clamps usage query bounds and passes the license token', async () => {
    await ctx.relayAccount.login('a@b.co', 'pw')
    await ctx.relayLicense.activate('KEY12345')
    expect(await ctx.relayLicense.usage(500, 0, 1000)).toEqual({ total: 3 })
    const request = seen.find(s => s.url.startsWith('/api/license/usage'))!
    expect(request.url).toBe('/api/license/usage?days=90&page=1&page_size=100')
    expect(request.auth).toMatch(/^Bearer lic-/)
  })

  it('reports an old backend without a usage route', async () => {
    await ctx.relayAccount.login('a@b.co', 'pw')
    await ctx.relayLicense.activate('KEY12345')
    usageStatus = 404
    await expect(ctx.relayLicense.usage()).rejects.toMatchObject({ code: 'rejected', status: 404 })
  })

  it('does not reuse another account token or balance on the same machine', async () => {
    await ctx.relayAccount.login('a@b.co', 'pw')
    await ctx.relayLicense.activate('ACCOUNT-A')
    activeUser = { id: 2, email: 'b@b.co', avatar_url: null }
    await ctx.relayAccount.login('b@b.co', 'pw')
    expect(await ctx.relayLicense.getCredentials()).toBeUndefined()
    expect(await ctx.relayLicense.getState()).toMatchObject({ activated: false, balance: 0, cardKey: '' })
    expect(await ctx.relayLicense.redeem('TOP-A')).toMatchObject({ ok: false })
    expect(seen.some(s => s.url === '/api/license/redeem')).toBe(false)
    restorable = true
    await ctx.relayLicense.restore()
    expect(seen.filter(s => s.url === '/api/license/restore').at(-1)?.auth).toBe('Bearer acct-2')
  })

  it('does not publish an old account activation response after account switch', async () => {
    await ctx.relayAccount.login('a@b.co', 'pw')
    const started = new Promise<void>(resolve => { activationStarted = resolve })
    const pending = ctx.relayLicense.activate('ACCOUNT-A')
    await started
    activeUser = { id: 2, email: 'b@b.co', avatar_url: null }
    await ctx.relayAccount.login('b@b.co', 'pw')
    holdActivation!()
    await pending
    expect(await ctx.relayLicense.getState()).toMatchObject({ activated: false, balance: 0, cardKey: '' })
    expect(await ctx.relayLicense.getCredentials()).toBeUndefined()
  })

  it('does not redeem an old account code on the new account after a delayed renewal', async () => {
    tokenTtlMs = 60_000
    await ctx.relayAccount.login('a@b.co', 'pw')
    await ctx.relayLicense.activate('ACCOUNT-A')
    const started = new Promise<void>(resolve => { heartbeatStarted = resolve })
    const pending = ctx.relayLicense.redeem('TOPUP-A')
    await started
    activeUser = { id: 2, email: 'b@b.co', avatar_url: null }
    tokenTtlMs = 3_600_000
    await ctx.relayAccount.login('b@b.co', 'pw')
    await ctx.relayLicense.activate('ACCOUNT-B')
    holdHeartbeat!()
    await expect(pending).resolves.toMatchObject({ ok: false })
    expect(seen.some(s => s.url === '/api/license/redeem')).toBe(false)
    expect(await ctx.relayLicense.getState()).toMatchObject({ balance: 12.5 })
  })

  it('ignores an unscoped legacy license instead of assigning its wallet to the current account', async () => {
    await ctx.credentials.modifyRecord(credentialKey('relay-license', 'default'), () => Promise.resolve({
      kind: 'grant', payload: {
        version: 1, cardKey: 'LEGACY', token: 'legacy-token', tokenExp: new Date(Date.now() + 3600000).toISOString(),
        cardExp: null, durationDays: 30, activated: true, message: '', balance: 999, billingEnabled: true, currency: '¥',
      },
    }))
    await ctx.relayAccount.login('a@b.co', 'pw')
    expect(await ctx.relayLicense.getCredentials()).toBeUndefined()
    expect(await ctx.relayLicense.getState()).toMatchObject({ balance: 0, activated: false })
  })

  it('does not return an expired token when renewal fails', async () => {
    tokenTtlMs = -1000
    await ctx.relayAccount.login('a@b.co', 'pw')
    await ctx.relayLicense.activate('KEY12345')
    heartbeatOk = false
    expect(await ctx.relayLicense.getCredentials()).toBeUndefined()
  })

  it('masks short and long keys', () => {
    expect(maskCardKey('ABCD')).toBe('ABCD')
    expect(maskCardKey('ABCDEFGHIJ')).toBe('ABCD****GHIJ')
  })
})
