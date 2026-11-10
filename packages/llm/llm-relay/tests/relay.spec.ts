import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmRelay from '../src/index.ts'
import { displayNameOf, relayBaseURL } from '../src/index.ts'

class FakeLicense extends Service {
  token: string | undefined = 'lic-1'
  constructor(ctx: Context) { super(ctx, 'relayLicense') }
  getCredentials() {
    return Promise.resolve(this.token === undefined ? undefined : { token: this.token, cardKey: 'K', deviceId: 'D' })
  }
}

const sse = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"hi relay"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
  '[DONE]',
]

let server: Server
let ctx!: Context
const seen: Array<{ url: string; auth: string | undefined; body: string; mediaParams: string | undefined }> = []

async function boot(): Promise<{ license: FakeLicense; url: string }> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, body: Buffer.concat(chunks).toString(), mediaParams: req.headers['x-relay-media-params'] as string | undefined })
      if (req.headers.authorization !== 'Bearer lic-1') { res.statusCode = 401; res.end('{}'); return }
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'relay-large', name: 'Relay Large', context_window: 65536, max_output: 4096 }, { id: 'relay-free', ratio: 0, free: true }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse.map(e => `data: ${e}\n\n`).join(''))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`
  ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const license = ctx.plugin(FakeLicense)
  await license
  await ctx.plugin(LlmRelay, { relayURL: url })
  return { license: ctx.get('relayLicense') as unknown as FakeLicense, url }
}

afterEach(async () => {
  seen.length = 0
  await ctx.fiber.dispose()
  server?.closeAllConnections()
  if (server) await new Promise<void>(resolve => server.close(() => { resolve() }))
})

describe('llm-relay', () => {
  it('normalizes the relay origin to a /v1 base', () => {
    ctx = new Context()
    expect(relayBaseURL('https://r.example.com/')).toBe('https://r.example.com/v1')
    expect(relayBaseURL('https://r.example.com/v1')).toBe('https://r.example.com/v1')
    expect(() => relayBaseURL('ftp://r.example.com')).toThrow()
  })

  it('lists relay models with the license token and streams a reply', async () => {
    await boot()
    const models = await ctx.llm.listModels('relay')
    expect(models.map(m => m.id)).toEqual(['relay-large', 'relay-free'])
    expect(seen[0]).toMatchObject({ url: '/v1/models', auth: 'Bearer lic-1' })

    let text = ''
    for await (const chunk of ctx.llm.stream({ provider: 'relay', model: 'relay-large', messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider: 'relay', model: 'relay-large' } })] })) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
    expect(text).toBe('hi relay')
    const chat = seen.find(s => s.url === '/v1/chat/completions')!
    expect(chat.auth).toBe('Bearer lic-1')
    expect(JSON.parse(chat.body)).toMatchObject({ model: 'relay-large', stream: true })
  })

  it('sends the session\'s chosen media parameters as a header only for that session and model', async () => {
    await boot()
    const params = new Map<string, Record<string, string | number>>([['s1\nrelay-large', { seconds: 8 }]])
    ctx.provide('mediaController', { paramsOf: (session: string, model: string) => params.get(`${session}\n${model}`) } as never)
    const message = createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'model', provider: 'relay', model: 'relay-large' } })
    for (const sessionId of ['s1', 's2']) {
      for await (const chunk of ctx.llm.stream({ provider: 'relay', model: 'relay-large', sessionId: sessionId as never, messages: [message] })) void chunk
    }
    const chats = seen.filter(s => s.url === '/v1/chat/completions')
    expect(chats.map(c => c.mediaParams)).toEqual(['{"seconds":8}', undefined])
  })

  it('labels models free or premium with their multiplier', () => {
    expect(displayNameOf({ id: 'a', free: true, ratio: 0 })).toBe('a · 免费')
    expect(displayNameOf({ id: 'b', name: 'B', free: false, ratio: 1.3 })).toBe('B · 高级 ×1.3')
    expect(displayNameOf({ id: 'c', free: false, ratio: 0.5 })).toBe('c · 高级 ×0.5')
    expect(displayNameOf({ id: 'd', name: 'D' })).toBe('D')
    expect(displayNameOf({ id: 'e' })).toBeUndefined()
  })

  it('offers no models and requests nothing while no card key is activated', async () => {
    const { license } = await boot()
    license.token = undefined
    expect(await ctx.llm.listModels('relay')).toEqual([])
    expect(seen).toHaveLength(0)
  })
})
