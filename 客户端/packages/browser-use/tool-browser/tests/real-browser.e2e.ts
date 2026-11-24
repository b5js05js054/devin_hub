/**
 * The `browser` tool against the real packaged CLI and a real installed
 * browser, driving registration and sign-in on a local site. It needs Chrome
 * or Microsoft Edge on the host, opens a visible window in one test, stores
 * then deletes one login in the user's agent-browser vault, and leaves the
 * saved state of its test Sessions (cookies of a 127.0.0.1 site) under
 * `~/.agent-browser/namespaces/dsh/`, so it runs only when `DSH_BROWSER_E2E=1`.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolBrowser from '@deepseek-ai/dsh-tool-browser'

const ENABLED = process.env['DSH_BROWSER_E2E'] === '1'

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`
}

const REGISTER_FORM = `<form method="post" action="/register">
<label for="username">Username</label><input id="username" name="username">
<label for="email">Email</label><input id="email" name="email" type="email">
<label for="password">Password</label><input id="password" name="password" type="password">
<input id="terms" name="terms" type="checkbox"><label for="terms">I accept the terms</label>
<button type="submit">Create account</button></form>`

const LOGIN_FORM = `<form method="post" action="/login">
<label for="username">Username</label><input id="username" name="username">
<label for="password">Password</label><input id="password" name="password" type="password">
<button type="submit">Sign in</button></form>`

/** One page with a target for every command family the guidance teaches. */
const WORKBENCH = `<p id="status">idle</p>
<label for="name">Name</label><input id="name" placeholder="Your name">
<label for="color">Color</label><select id="color"><option value="r">Red</option><option value="g">Green</option></select>
<input id="agree" type="checkbox"><label for="agree">Agree</label>
<label for="doc">Document</label><input id="doc" type="file">
<button id="hello" data-testid="hello" onclick="document.getElementById('status').textContent='clicked'">Hello</button>
<button id="twice" ondblclick="document.getElementById('status').textContent='double'">Twice</button>
<button id="ask" onclick="document.getElementById('status').textContent='answer:'+prompt('Your answer?')">Ask</button>
<button id="log" onclick="console.log('logged-line');localStorage.setItem('k','v')">Log</button>
<a id="next" href="/second">Second page</a>
<a id="report" href="/report.txt">Report</a>
<div id="src" draggable="true">drag me</div><div id="dst">drop here</div>
<div style="height:2000px"></div><p id="bottom">bottom</p>
<iframe id="inner" src="/frame" title="Inner"></iframe>`

async function formBody(request: IncomingMessage): Promise<URLSearchParams> {
  let text = ''
  for await (const chunk of request) text += String(chunk)
  return new URLSearchParams(text)
}

/** A site with registration, sign-in, and a signed-in page, kept in memory. */
async function startSite() {
  const accounts = new Map<string, string>()
  const logins = new Map<string, string>()
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://site.invalid')
      const html = (status: number, text: string) => {
        response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
        response.end(text)
      }
      const redirect = (location: string, cookie?: string) => {
        response.writeHead(303, { location, ...cookie === undefined ? {} : { 'set-cookie': cookie } })
        response.end()
      }
      const route = `${request.method} ${url.pathname}`
      if (route === 'GET /register') {
        html(200, page('Create your account', REGISTER_FORM))
      } else if (route === 'POST /register') {
        const form = await formBody(request)
        if (form.get('terms') !== 'on') {
          html(400, page('Create your account', `<p role="alert">You must accept the terms</p>${REGISTER_FORM}`))
          return
        }
        accounts.set(form.get('username') ?? '', form.get('password') ?? '')
        redirect('/login?registered=1')
      } else if (route === 'GET /login') {
        html(200, page('Sign in', `${url.searchParams.has('registered') ? '<p>Account created. Sign in to continue.</p>' : ''}${LOGIN_FORM}`))
      } else if (route === 'POST /login') {
        const form = await formBody(request)
        const username = form.get('username') ?? ''
        if (!accounts.has(username) || accounts.get(username) !== form.get('password')) {
          html(401, page('Sign in', `<p role="alert">Wrong username or password</p>${LOGIN_FORM}`))
          return
        }
        const id = randomUUID()
        logins.set(id, username)
        redirect('/dashboard', `sid=${id}; Path=/; HttpOnly; Max-Age=3600`)
      } else if (route === 'GET /dashboard') {
        const id = /(?:^|;\s*)sid=([^;]+)/u.exec(request.headers.cookie ?? '')?.[1]
        const username = id === undefined ? undefined : logins.get(id)
        if (username === undefined) redirect('/login')
        else html(200, page(`Welcome, ${username}`, '<p>You are signed in.</p>'))
      } else if (route === 'GET /workbench') {
        html(200, page('Workbench', WORKBENCH))
      } else if (route === 'GET /second') {
        html(200, page('Second', '<a href="/workbench">Back to the workbench</a>'))
      } else if (route === 'GET /frame') {
        html(200, page('Framed', '<button id="inside">Inside</button>'))
      } else if (route === 'GET /report.txt') {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="report.txt"' })
        response.end('quarterly report')
      } else {
        html(404, page('Not found', ''))
      }
    })()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, accounts }
}

/** Mount the tool exactly as a preset does: packaged CLI, host browser, default launch settings. */
async function mount(outputRoot: string, config: ToolBrowser.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  const fiber = await ctx.plugin(Object.assign((inner: Context) => {
    ToolBrowser.apply(inner, ToolBrowser.Config(config), { outputRoot })
  }, { inject: ToolBrowser.inject }))
  return { ctx, unload: async () => { await fiber.dispose(); await ctx.fiber.dispose() } }
}

async function outputDirectory(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-tool-browser-e2e-')))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) })
  return root
}

/** Whether a tool value has the browser tool's canonical shape. */
function isBrowserOutput(value: unknown): value is ToolBrowser.BrowserOutput {
  return typeof value === 'object' && value !== null && 'results' in value && 'skipped' in value && 'files' in value
}

let calls = 0
async function run(ctx: Context, commands: string[][], options: { headed?: boolean; session?: string } = {}) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`browser-e2e-${++calls}`),
    name: 'browser',
    arguments: { commands, ...options.headed === undefined ? {} : { headed: options.headed } },
    ...options.session === undefined ? {} : { agent: { session: { id: options.session } } as never },
  })
  const text = result.content.map(block => 'text' in block ? block.text : '').join('')
  expect(result.isError, text).toBe(false)
  const output = result.value
  if (!isBrowserOutput(output)) throw new Error(`the browser tool returned no outcome list: ${text}`)
  expect(output.results.map(entry => [entry.command[0], entry.success, entry.error]), text)
    .toEqual(commands.map(command => [command[0], true, undefined]))
  return { output, text, data: (index: number) => output.results[index]!.result as Record<string, unknown> }
}

/** Find the ref a snapshot assigned to a named element. */
function ref(snapshot: string, role: string, name: string): string {
  const match = new RegExp(`- ${role} "${name}" \\[[^\\n]*\\bref=(e\\d+)\\]`, 'u').exec(snapshot)
  expect(match, `${role} "${name}" in:\n${snapshot}`).not.toBeNull()
  return `@${match![1]}`
}

describe.skipIf(!ENABLED)('browser tool with a real browser', () => {
  it('registers an account, is refused a wrong password, signs in, and captures the signed-in page', async () => {
    const site = await startSite()
    const outputRoot = await outputDirectory()
    const { ctx, unload } = await mount(outputRoot)
    onTestFinished(unload)

    const opened = await run(ctx, [['open', `${site.origin}/register`], ['snapshot', '-i']])
    const form = opened.data(1)['snapshot'] as string
    expect(opened.text).toContain(`$ snapshot -i\n${form}`)

    const registered = await run(ctx, [
      ['fill', ref(form, 'textbox', 'Username'), 'alice'],
      ['fill', ref(form, 'textbox', 'Email'), 'alice@example.test'],
      ['fill', ref(form, 'textbox', 'Password'), 'correct horse battery'],
      ['check', ref(form, 'checkbox', 'I accept the terms')],
      ['click', ref(form, 'button', 'Create account')],
      ['wait', '--url', '**/login*'],
      ['get', 'url'],
    ])
    expect(registered.data(6)['url']).toBe(`${site.origin}/login?registered=1`)
    expect([...site.accounts]).toEqual([['alice', 'correct horse battery']])

    const refused = await run(ctx, [
      ['find', 'label', 'Username', 'fill', 'alice'],
      ['find', 'label', 'Password', 'fill', 'wrong'],
      ['find', 'role', 'button', 'click', '--name', 'Sign in'],
      ['wait', '--text', 'Wrong username or password'],
      ['get', 'url'],
    ])
    expect(refused.data(4)['url']).toBe(`${site.origin}/login`)

    const signedIn = await run(ctx, [
      ['find', 'label', 'Username', 'fill', 'alice'],
      ['find', 'label', 'Password', 'fill', 'correct horse battery'],
      ['press', 'Enter'],
      ['wait', '--url', '**/dashboard'],
      ['get', 'text', 'h1'],
      ['screenshot', 'dashboard.png'],
      ['cookies'],
    ])
    expect(signedIn.data(4)['text']).toBe('Welcome, alice')
    const saved = signedIn.data(5)['path'] as string
    expect(isAbsolute(saved)).toBe(true)
    expect(saved.startsWith(outputRoot)).toBe(true)
    expect(existsSync(saved)).toBe(true)
    expect(JSON.stringify(signedIn.data(6))).toContain('"name":"sid"')

    // A failed command is an outcome of the call, and later commands do not run.
    const failed = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`browser-e2e-${++calls}`),
      name: 'browser',
      arguments: { commands: [['click', '@e999'], ['get', 'url']] },
    })
    expect(failed.isError).toBe(false)
    expect(failed.value).toMatchObject({ results: [{ command: ['click', '@e999'], success: false }], skipped: 1 })
  })

  it('shows the window on request and keeps a saved sign-in across a browser restart', async () => {
    const site = await startSite()
    site.accounts.set('bob', 'pass phrase')
    const outputRoot = await outputDirectory()
    const session = `e2e-${randomUUID()}`
    const first = await mount(outputRoot, { restore: 'session' })
    let unloaded = false
    onTestFinished(async () => { if (!unloaded) await first.unload() })

    const signedIn = await run(first.ctx, [
      ['open', `${site.origin}/login`],
      ['find', 'label', 'Username', 'fill', 'bob'],
      ['find', 'label', 'Password', 'fill', 'pass phrase'],
      ['find', 'role', 'button', 'click', '--name', 'Sign in'],
      ['wait', '--url', '**/dashboard'],
      ['get', 'text', 'h1'],
    ], { session })
    expect(signedIn.data(5)['text']).toBe('Welcome, bob')

    // Showing the window restarts the browser; the saved state carries the sign-in over.
    const visible = await run(first.ctx, [['open', `${site.origin}/dashboard`], ['get', 'text', 'h1']], { session, headed: true })
    expect(visible.data(1)['text']).toBe('Welcome, bob')

    // Unloading closes the browser; a later instance of the same Session is still signed in.
    await first.unload()
    unloaded = true
    const second = await mount(outputRoot, { restore: 'session' })
    onTestFinished(second.unload)
    const restored = await run(second.ctx, [['open', `${site.origin}/dashboard`], ['get', 'text', 'h1']], { session })
    expect(restored.data(1)['text']).toBe('Welcome, bob')

    // Without saved state a new Session starts signed out.
    const stranger = await run(second.ctx, [['open', `${site.origin}/dashboard`], ['get', 'url']], { session: `e2e-${randomUUID()}` })
    expect(stranger.data(1)['url']).toBe(`${site.origin}/login`)
  })

  it('runs every command family the guidance teaches', async () => {
    const site = await startSite()
    const outputRoot = await outputDirectory()
    const { ctx, unload } = await mount(outputRoot, { maxCommands: 40 })
    onTestFinished(unload)
    const workbench = `${site.origin}/workbench`
    const upload = join(outputRoot, 'upload.txt')
    await writeFile(upload, 'uploaded')

    const read = await run(ctx, [
      ['open', workbench], ['snapshot', '-i'], ['snapshot', '-i', '-u'], ['snapshot', '-s', '#hello'], ['snapshot'],
      ['get', 'title'], ['get', 'url'], ['get', 'text', '#status'], ['get', 'html', '#status'], ['get', 'count', 'button'],
      ['get', 'attr', '#name', 'placeholder'], ['is', 'visible', '#hello'], ['is', 'enabled', '#hello'], ['is', 'checked', '#agree'],
      ['read'], ['eval', 'document.title + 1'],
    ])
    expect(read.data(2)['snapshot']).toContain(`${site.origin}/second`)
    expect(read.data(3)['snapshot']).toBe('- button "Hello" [ref=e6]')
    expect([read.data(5)['title'], read.data(7)['text'], read.data(9)['count'], read.data(10)['value'], read.data(15)['result']])
      .toEqual(['Workbench', 'idle', 4, 'Your name', 'Workbench1'])
    expect(JSON.stringify(read.data(14))).toContain('Workbench')

    const acted = await run(ctx, [
      ['fill', '#name', 'Ada Lovelace'], ['type', '#name', ' II'], ['get', 'value', '#name'],
      ['fill', '#name', '--', '-dash first'], ['get', 'value', '#name'],
      ['focus', '#name'], ['press', 'Control+a'], ['keyboard', 'type', 'typed text'], ['get', 'value', '#name'],
      ['select', '#color', 'g'], ['get', 'value', '#color'], ['check', '#agree'], ['is', 'checked', '#agree'], ['uncheck', '#agree'],
      ['hover', '#hello'], ['click', '#hello'], ['get', 'text', '#status'], ['dblclick', '#twice'], ['get', 'text', '#status'],
      ['scroll', 'down', '300'], ['scrollintoview', '#bottom'], ['scroll', 'up'], ['drag', '#src', '#dst'],
      ['mouse', 'move', '20', '20'], ['mouse', 'down'], ['mouse', 'up'],
      ['upload', '#doc', upload], ['eval', 'document.getElementById("doc").files[0].name'],
    ])
    expect([
      acted.data(2)['value'], acted.data(4)['value'], acted.data(8)['value'], acted.data(10)['value'],
      acted.data(12)['checked'], acted.data(16)['text'], acted.data(18)['text'], acted.data(27)['result'],
    ]).toEqual(['Ada Lovelace II', '-dash first', 'typed text', 'g', true, 'clicked', 'double', 'upload.txt'])

    const found = await run(ctx, [
      ['find', 'role', 'button', 'click', '--name', 'Hello'], ['find', 'text', 'Hello', 'click'], ['find', 'testid', 'hello', 'click'],
      ['find', 'label', 'Name', 'fill', 'by label'], ['find', 'placeholder', 'Your name', 'fill', 'by placeholder'], ['get', 'value', '#name'],
      ['wait', '#hello'], ['wait', '--text', 'Workbench'], ['wait', '--url', '**/workbench'], ['wait', '--load', 'load'],
      ['wait', '--fn', 'document.readyState === "complete"'], ['wait', '50'],
    ])
    expect(found.data(5)['value']).toBe('by placeholder')

    const state = await run(ctx, [
      ['click', '#log'], ['console'], ['errors'], ['storage', 'local'], ['storage', 'local', 'k'],
      ['cookies', 'set', 'probe', 'one'], ['cookies'], ['cookies', 'clear'], ['cookies'],
      ['network', 'requests', '--filter', 'workbench'], ['set', 'viewport', '800', '600'], ['eval', 'window.innerWidth'],
    ])
    expect(JSON.stringify(state.data(1))).toContain('logged-line')
    expect([state.data(4)['value'], state.data(11)['result']]).toEqual(['v', 800])
    expect([JSON.stringify(state.data(6)).includes('"name":"probe"'), JSON.stringify(state.data(8)).includes('"name":"probe"')]).toEqual([true, false])

    const framed = await run(ctx, [
      ['frame', '#inner'], ['snapshot', '-i'], ['click', '#inside'], ['frame', 'main'], ['get', 'title'],
      ['click', '#ask'], ['dialog', 'accept', 'forty two'], ['get', 'text', '#status'],
      ['click', '#ask'], ['dialog', 'dismiss'], ['get', 'text', '#status'],
    ])
    expect(framed.data(1)['snapshot']).toBe('- heading "Framed" [level=1, ref=e15]\n- button "Inside" [ref=e16]')
    expect([framed.data(7)['text'], framed.data(10)['text']]).toEqual(['answer:forty two', 'answer:null'])

    const tabs = await run(ctx, [
      ['click', '#next'], ['wait', '--url', '**/second'], ['back'], ['get', 'url'], ['forward'], ['get', 'url'], ['reload'], ['get', 'title'],
      ['tab', 'new', workbench], ['tab'], ['tab', 't1'], ['get', 'url'], ['tab', 'close', 't2'],
      ['open', workbench], ['click', '#next', '--new-tab'], ['get', 'url'], ['tab', 'close'], ['tab'],
    ])
    expect([tabs.data(3)['url'], tabs.data(5)['url'], tabs.data(7)['title'], tabs.data(11)['url'], tabs.data(15)['url']])
      .toEqual([workbench, `${site.origin}/second`, 'Second', `${site.origin}/second`, `${site.origin}/second`])
    expect((tabs.data(17)['tabs'] as unknown[]).length).toBe(1)

    const captured = await run(ctx, [
      ['screenshot'], ['screenshot', 'named.png'], ['screenshot', '--full', 'full.png'], ['pdf', 'page.pdf'], ['click', '#report'], ['wait', '1500'],
    ])
    const session = join(outputRoot, (await readdir(outputRoot)).find(name => name.startsWith('session-'))!)
    expect(captured.data(0)['path']).toMatch(/screenshot-\d+\.png$/u)
    expect([1, 2, 3].map(index => captured.data(index)['path'])).toEqual(['named.png', 'full.png', 'page.pdf'].map(name => join(session, name)))
    expect(captured.text).not.toContain('labels drawn on the image')
    expect(captured.text).toContain(`Saved files:\n${join(session, 'report.txt')}`)
    expect(captured.output.files).toEqual([
      join(session, 'full.png'), join(session, 'named.png'), join(session, 'page.pdf'), join(session, 'report.txt'), captured.data(0)['path'],
    ])
    expect(await readFile(join(session, 'report.txt'), 'utf8')).toBe('quarterly report')

    const annotated = await run(ctx, [['screenshot', '--annotate', 'annotated.png'], ['get', 'url']])
    expect(annotated.text).toMatch(/^\$ screenshot annotated\.png\nlabels drawn on the image:\n {2}\[(\d+)\] @e\1 heading "Workbench"\n/u)
    expect(annotated.output.files).toEqual([join(session, 'annotated.png')])
    // Showing or hiding labels does not restart the browser.
    expect(annotated.data(1)).toEqual({ url: workbench })

    const login = `e2e-${randomUUID()}`
    site.accounts.set('dave', 'vault pass')
    const saved = await run(ctx, [
      ['state', 'save', 'state.json'], ['state', 'load', 'state.json'],
      ['auth', 'save', login, '--url', `${site.origin}/login`, '--username', 'dave', '--password', 'vault pass'], ['auth', 'list'],
      ['auth', 'login', login], ['wait', '--url', '**/dashboard'], ['get', 'text', 'h1'], ['auth', 'delete', login],
      ['close'], ['open', workbench], ['get', 'title'],
    ])
    expect(saved.data(0)['path']).toBe(join(session, 'state.json'))
    expect(JSON.stringify(saved.data(3))).toContain(login)
    expect([saved.data(6)['text'], saved.data(10)['title']]).toEqual(['Welcome, dave', 'Workbench'])
  })
})
