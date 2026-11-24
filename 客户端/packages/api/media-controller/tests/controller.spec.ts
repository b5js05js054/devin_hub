/** Spec lookup maps relay answers to values, and chosen parameters are scoped per session and model. */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import MediaController from '../src/index.ts'

const roots: Context[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map((server) => new Promise<void>(resolve => { server.close(() => { resolve() }) })))
})

const videoSpec = {
  kind: 'video', source: 'upstream',
  fields: [{ key: 'seconds', label: 'Seconds', type: 'number', min: 1, max: 30, default: 5, required: false }],
}

async function fixture(credentials: { token: string } | null = { token: 'tok' }) {
  const seen: Array<{ url: string; authorization: string | undefined }> = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', authorization: req.headers.authorization })
    const model = new URL(req.url ?? '', 'http://x').searchParams.get('model')
    if (model === 'gpt-4') { res.statusCode = 404; res.end('nope'); return }
    if (model === 'broken') { res.statusCode = 500; res.end(); return }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(videoSpec))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const ctx = new Context()
  roots.push(ctx)
  ctx.provide('relayLicense', { getCredentials: vi.fn(() => Promise.resolve(credentials ?? undefined)) } as never)
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api`
  return { seen, controller: new MediaController(ctx, { relayURL: url }) }
}

it('fetches the spec with the license token', async () => {
  const { controller, seen } = await fixture()
  expect(await controller.getSpec('sora')).toEqual({ ok: true, spec: videoSpec })
  expect(seen[0]).toEqual({ url: '/api/v1/media/spec?model=sora', authorization: 'Bearer tok' })
})

it('reports chat models, missing activation and relay failures as values', async () => {
  const { controller } = await fixture()
  expect(await controller.getSpec('gpt-4')).toMatchObject({ ok: false, code: 'not-media' })
  expect(await controller.getSpec('broken')).toMatchObject({ ok: false, code: 'unavailable', message: 'HTTP 500' })
  const signedOut = await fixture(null)
  expect(await signedOut.controller.getSpec('sora')).toMatchObject({ ok: false, code: 'not-activated' })
  expect(signedOut.seen).toHaveLength(0)
})

it('scopes chosen parameters by session and model and clears on empty', async () => {
  const { controller } = await fixture()
  controller.setParams('s1', 'sora', { seconds: 8 })
  expect(controller.paramsOf('s1', 'sora')).toEqual({ seconds: 8 })
  expect(controller.paramsOf('s2', 'sora')).toBeUndefined()
  expect(controller.paramsOf('s1', 'other')).toBeUndefined()
  controller.setParams('s1', 'sora', {})
  expect(controller.paramsOf('s1', 'sora')).toBeUndefined()
})
