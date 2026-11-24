/**
 * The `browser` tool through the real tool registry and the real local
 * subprocess service, with a scripted stand-in for the CLI program. These
 * verify what the CLI is asked to do and what the model and callers receive.
 */

import { mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolBrowser from '@deepseek-ai/dsh-tool-browser'
import type { BrowserHost } from '../src/executable.ts'
import { browserGuidance } from '../src/prompt.ts'
import type { GuidanceFacts } from '../src/prompt.ts'

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-agent-browser.mjs', import.meta.url))
const NO_BROWSER_HOST: BrowserHost = { platform: 'linux', env: {}, exists: () => false }

interface Invocation {
  argv: string[]
  cwd: string
  env: Record<string, string>
  stdin: string
}

interface SetupOptions {
  host?: BrowserHost
  mode?: SandboxMode
  program?: () => readonly string[]
}

async function setup(config: ToolBrowser.Config = {}, options: SetupOptions = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-tool-browser-')))
  const log = join(root, 'invocations.jsonl')
  const outputRoot = join(root, 'output')
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  const { mode } = options
  if (mode !== undefined) {
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode, workspaceRoot: root }) } as never)
  }
  /** Mount the plugin; called again after a dispose, it is a later run over the same output root. */
  const mount = () => ctx.plugin(Object.assign((inner: Context) => {
    ToolBrowser.apply(inner, ToolBrowser.Config(config), {
      program: options.program ?? (() => [process.execPath, FAKE_CLI, log]),
      host: options.host ?? NO_BROWSER_HOST,
      outputRoot,
    })
  }, { inject: ToolBrowser.inject }))
  const fiber = await mount()
  const invocations = async (): Promise<Invocation[]> => {
    const text = await readFile(log, 'utf8').catch(() => '')
    return text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as Invocation)
  }
  return { ctx, fiber, mount, outputRoot, invocations }
}

let calls = 0
function call(ctx: Context, args: unknown, options: { session?: string; signal?: AbortSignal } = {}) {
  return ctx.tools.execute({
    signal: options.signal ?? new AbortController().signal,
    callId: ToolCallId(`browser-${++calls}`),
    name: 'browser',
    arguments: args,
    ...options.session === undefined ? {} : { agent: { session: { id: options.session } } as never },
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map(block => block.text ?? '').join('')
}

/** The launch settings sent to the CLI: the arguments between the session pair and the saved-file settings. */
function launchArguments(invocation: Invocation): string[] {
  return invocation.argv.slice(4, invocation.argv.indexOf('--screenshot-dir'))
}

describe('browser tool', () => {
  it('runs the commands in order in the Session browser and returns each outcome', async () => {
    const { ctx, outputRoot, invocations } = await setup()
    const commands = [['open', 'https://example.test/login'], ['snapshot', '-i'], ['fill', '@e3', 'two words']]
    const result = await call(ctx, { commands }, { session: 'session-a' })
    expect(result).toMatchObject({
      isError: false,
      value: {
        results: [
          { command: ['open', 'https://example.test/login'], success: true, result: { targetId: 'T1', echoed: ['https://example.test/login'] } },
          { command: ['snapshot', '-i'], success: true, result: { snapshot: '- button "Sign in" [ref=e1]' } },
          { command: ['fill', '@e3', 'two words'], success: true, result: { echoed: ['@e3', 'two words'] } },
        ],
        skipped: 0,
        files: [],
      },
    })
    expect(text(result)).toBe([
      '$ open https://example.test/login\nechoed: ["https://example.test/login"]',
      '$ snapshot -i\n- button "Sign in" [ref=e1]',
      '$ fill @e3 "two words"\nechoed: ["@e3","two words"]',
    ].join('\n\n'))

    const [invocation] = await invocations()
    const session = invocation!.argv[3]!
    expect(session).toMatch(/^session-[0-9a-f]{16}$/)
    expect(invocation).toMatchObject({
      argv: [
        '--namespace', 'dsh', '--session', session, '--headed', 'false',
        '--screenshot-dir', join(outputRoot, session), '--download-path', join(outputRoot, session),
        'batch', '--json', '--bail',
      ],
      cwd: join(outputRoot, session),
      stdin: JSON.stringify(commands),
    })
  })

  it('gives each Session its own browser and agentless calls one shared browser', async () => {
    const { ctx, invocations } = await setup()
    await call(ctx, { commands: [['get', 'url']] }, { session: 'session-a' })
    await call(ctx, { commands: [['get', 'url']] }, { session: 'session-b' })
    await call(ctx, { commands: [['get', 'url']] }, { session: 'session-a' })
    await call(ctx, { commands: [['get', 'url']] })
    await call(ctx, { commands: [['get', 'url']] })
    const sessions = (await invocations()).map(invocation => invocation.argv[3])
    expect(sessions[0]).toBe(sessions[2])
    expect(sessions[3]).toBe(sessions[4])
    expect(new Set(sessions).size).toBe(3)
  })

  it('keeps the window visibility last set for a Session', async () => {
    const { ctx, invocations } = await setup()
    await call(ctx, { commands: [['open', 'https://example.test']] }, { session: 'session-a' })
    await call(ctx, { commands: [['open', 'https://example.test']], headed: true }, { session: 'session-a' })
    await call(ctx, { commands: [['snapshot', '-i']] }, { session: 'session-a' })
    await call(ctx, { commands: [['snapshot', '-i']] }, { session: 'session-b' })
    await call(ctx, { commands: [['close']], headed: false }, { session: 'session-a' })
    expect((await invocations()).map(launchArguments)).toEqual([
      ['--headed', 'false'], ['--headed', 'true'], ['--headed', 'true'], ['--headed', 'false'], ['--headed', 'false'],
    ])

    const visible = await setup({ headed: true })
    await call(visible.ctx, { commands: [['get', 'url']] })
    expect((await visible.invocations()).map(launchArguments)).toEqual([['--headed', 'true']])
  })

  it('sends the configured browser, launch arguments, and saved-state key', async () => {
    const executablePath = process.platform === 'win32' ? 'D:\\Browsers\\chrome.exe' : '/opt/browsers/chrome'
    const configured = await setup({ executablePath, browserArgs: ['--lang=zh-CN', '--window-size=1280,800'], restore: 'session' })
    await call(configured.ctx, { commands: [['get', 'url']] }, { session: 'session-a' })
    const [first] = await configured.invocations()
    expect(launchArguments(first!)).toEqual([
      '--headed', 'false', '--executable-path', executablePath, '--args', '--lang=zh-CN,--window-size=1280,800', '--restore', first!.argv[3],
    ])

    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    const windows = await setup({ restore: 'shared' }, {
      host: { platform: 'win32', env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }, exists: path => path === edge },
    })
    await call(windows.ctx, { commands: [['get', 'url']] })
    expect((await windows.invocations()).map(launchArguments)).toEqual([
      ['--headed', 'false', '--executable-path', edge, '--args', '--do-not-de-elevate', '--restore', 'shared'],
    ])
  })

  it('removes ambient CLI settings from the program environment', async () => {
    vi.stubEnv('AGENT_BROWSER_CDP', '9222')
    vi.stubEnv('AGENT_BROWSER_SESSION', 'ambient')
    onTestFinished(() => { vi.unstubAllEnvs() })
    const { ctx, invocations } = await setup({}, { host: { ...NO_BROWSER_HOST, env: process.env } })
    await call(ctx, { commands: [['get', 'url']] })
    expect((await invocations()).map(invocation => invocation.env)).toEqual([{ AGENT_BROWSER_NO_VERSION_CHECK: '1' }])
  })

  it('stops at the first failed command and reports it as an outcome', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, { commands: [['get', 'url'], ['fail', 'Unknown ref: e9'], ['get', 'title'], ['back']] })
    expect(result.isError).toBe(false)
    expect(result).toMatchObject({
      value: {
        results: [{ command: ['get', 'url'], success: true }, { command: ['fail', 'Unknown ref: e9'], success: false, error: 'Unknown ref: e9' }],
        skipped: 2,
      },
    })
    expect(text(result)).toBe('$ get url\nechoed: ["url"]\n\n$ fail "Unknown ref: e9"\nError: Unknown ref: e9\n\n(2 later commands were not run)')
  })

  it('reports saved files by absolute path and marks a browser restart', async () => {
    const { ctx, outputRoot, invocations } = await setup()
    const result = await call(ctx, { commands: [['screenshot', 'login.png'], ['relaunch'], ['scalar'], ['nothing'], ['snapshot', '--empty']] })
    const session = (await invocations())[0]!.argv[3]!
    const saved = join(outputRoot, session, 'login.png')
    expect(result).toMatchObject({
      isError: false,
      value: {
        results: [{ result: { path: saved } }, { result: { url: 'about:blank', browserRestarted: true } }, { result: 42 }, { success: true }, { success: true }],
        files: [saved],
      },
    })
    expect(text(result)).toBe([
      `$ screenshot login.png\npath: ${saved}`,
      '$ relaunch\nnote: the browser restarted for this command; pages and logins from before are gone\nurl: about:blank',
      '$ scalar\n42',
      '$ nothing\nok',
      '$ snapshot --empty\n(the page has no matching elements)',
    ].join('\n\n'))
  })

  it('reports each file the browser saved on its own once, and none left by an earlier run', async () => {
    const { ctx, fiber, mount, invocations } = await setup()
    const first = await call(ctx, { commands: [['save', 'earlier.pdf']] }, { session: 'session-a' })
    const { cwd } = (await invocations())[0]!
    expect(first).toMatchObject({ isError: false, value: { files: [join(cwd, 'earlier.pdf')] } })
    expect(text(first)).toBe(`$ save earlier.pdf\nclicked: #download\n\nSaved files:\n${join(cwd, 'earlier.pdf')}`)

    await fiber.dispose()
    await mount()
    const second = await call(ctx, {
      commands: [['save', 'sheet.xlsx', 'movie.mp4.crdownload'], ['folder', 'unpacked'], ['screenshot', 'page.png']],
    }, { session: 'session-a' })
    expect(second).toMatchObject({ isError: false, value: { files: [join(cwd, 'page.png'), join(cwd, 'sheet.xlsx')] } })
    expect(text(second)).toBe([
      '$ save sheet.xlsx movie.mp4.crdownload\nclicked: #download',
      '$ folder unpacked\nok',
      `$ screenshot page.png\npath: ${join(cwd, 'page.png')}`,
      `Saved files:\n${join(cwd, 'sheet.xlsx')}`,
    ].join('\n\n'))

    // A download that finishes after its call is reported by the next one.
    await rename(join(cwd, 'movie.mp4.crdownload'), join(cwd, 'movie.mp4'))
    const third = await call(ctx, { commands: [['get', 'url']] }, { session: 'session-a' })
    expect(third).toMatchObject({ isError: false, value: { files: [join(cwd, 'movie.mp4')] } })
    expect(await call(ctx, { commands: [['get', 'url']] }, { session: 'session-a' })).toMatchObject({ value: { files: [] } })
  })

  it('labels screenshots when one asks for annotation, and lists the labels by ref', async () => {
    const { ctx, invocations } = await setup()
    const result = await call(ctx, { commands: [['screenshot', '--annotate', 'marked.png'], ['annotated']] })
    const [invocation] = await invocations()
    expect(invocation!.argv.slice(invocation!.argv.indexOf('--download-path') + 2)).toEqual(['--annotate', 'batch', '--json', '--bail'])
    expect(invocation!.stdin).toBe('[["screenshot","marked.png"],["annotated"]]')
    const saved = join(invocation!.cwd, 'marked.png')
    expect(text(result)).toBe([
      `$ screenshot marked.png\npath: ${saved}`,
      `$ annotated\nlabels drawn on the image:\n  [1] @e1 button "Sign in"\n  unlabelled\npath: ${saved}`,
    ].join('\n\n'))

    await call(ctx, { commands: [['screenshot', 'plain.png']] })
    expect((await invocations())[1]!.argv).not.toContain('--annotate')
  })

  it('bounds one command result by the configured character budget', async () => {
    const { ctx } = await setup({ maxResultChars: 12 })
    const result = await call(ctx, { commands: [['snapshot', '-i']] })
    expect(text(result)).toBe('$ snapshot -i\n- button "Si\n[15 more characters omitted; narrow the request, for example with snapshot -i, snapshot -s <selector>, or get text <selector>]')
  })

  it.each([
    [[['raw', 'not json']], 'BROWSER_FAILED', 'Error: the browser returned output that is not a result report'],
    [[['badrow']], 'BROWSER_FAILED', 'Error: the browser returned a malformed result for command 1'],
    [[['extra']], 'BROWSER_FAILED', 'Error: the browser returned a result report that does not match the submitted commands'],
    [[['silent', '2', '✗ Daemon failed to start']], 'BROWSER_FAILED', 'Error: the browser could not run the commands: ✗ Daemon failed to start'],
    [[['silent', '3']], 'BROWSER_FAILED', 'Error: the browser could not run the commands (exit code 3)'],
    [[['flood', '5000']], 'BROWSER_OUTPUT_OVERFLOW', 'Error: the browser returned more than 1024 bytes; the commands ran, so read the page again with a narrower request such as snapshot -i or get text <selector>'],
  ])('fails the call for the unusable program outcome %j', async (commands, code, message) => {
    const { ctx } = await setup({ maxOutputBytes: 1024 })
    const result = await call(ctx, { commands })
    expect(result.isError).toBe(true)
    expect(result.error?.info).toEqual({ name: 'BrowserToolError', code })
    expect(text(result)).toBe(message)
  })

  it('stops the running program when the call is cancelled', async () => {
    const { ctx, invocations } = await setup({ graceMs: 200 })
    const controller = new AbortController()
    const pending = call(ctx, { commands: [['hang']] }, { signal: controller.signal })
    await vi.waitFor(async () => { expect(await invocations()).toHaveLength(1) }, { timeout: 15_000, interval: 50 })
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.error?.info).toEqual({ name: 'BrowserToolError', code: 'BROWSER_ABORTED' })
  })

  it('rejects denied and malformed commands before running anything', async () => {
    const { ctx, invocations } = await setup({ maxCommands: 2 })
    const denied = await call(ctx, { commands: [['open', 'https://example.test'], ['install']] })
    expect(denied.error?.info).toEqual({ name: 'BrowserToolError', code: 'BROWSER_COMMAND_DENIED' })
    expect(text(denied)).toBe('Error: command 2: "install" is not available through this tool: installing a browser is a deployment task; ask the user to install Google Chrome or Microsoft Edge')

    const oversized = await call(ctx, { commands: [['back'], ['back'], ['back']] })
    expect(oversized.error?.info).toEqual({ name: 'BrowserToolError', code: 'BROWSER_INVALID_COMMAND' })

    const everySession = await call(ctx, { commands: [['state', 'clear']] })
    expect(everySession.error?.info).toEqual({ name: 'BrowserToolError', code: 'BROWSER_COMMAND_DENIED' })

    const mistyped = await call(ctx, { commands: [['open', 7]] })
    expect(mistyped.error?.info).toEqual({ name: 'ToolArgsError', code: 'INVALID_ARGS' })
    expect(await invocations()).toEqual([])
  })

  it('confines file-saving commands to the output directory under a confining sandbox mode', async () => {
    const absolute = process.platform === 'win32' ? 'C:\\Users\\me\\page.png' : '/home/me/page.png'
    const confined = await setup({}, { mode: 'read-only' })
    const denied = await call(confined.ctx, { commands: [['screenshot', absolute]] }, { session: 'session-a' })
    expect(denied.error?.info).toEqual({ name: 'BrowserToolError', code: 'BROWSER_SANDBOX_DENIED' })
    expect(text(denied)).toContain('[sandbox: file access denied under read-only mode]')
    expect(await confined.invocations()).toEqual([])
    const relative = await call(confined.ctx, { commands: [['screenshot', 'page.png']] }, { session: 'session-a' })
    expect(relative.isError).toBe(false)

    const open = await setup({}, { mode: 'danger-full-access' })
    const elsewhere = join(open.outputRoot, 'elsewhere.png')
    const unconfined = await call(open.ctx, { commands: [['screenshot', elsewhere]] })
    expect(unconfined).toMatchObject({ isError: false, value: { results: [{ result: { path: elsewhere } }], files: [] } })
  })

  it('closes every browser it started when the plugin unloads', async () => {
    const { ctx, fiber, invocations } = await setup()
    await call(ctx, { commands: [['open', 'https://example.test']] }, { session: 'session-a' })
    await call(ctx, { commands: [['open', 'https://example.test']] }, { session: 'session-b' })
    await call(ctx, { commands: [['install']] }, { session: 'session-c' })
    const started = (await invocations()).map(invocation => invocation.argv[3])
    await fiber.dispose()
    const closes = (await invocations()).filter(invocation => invocation.argv.includes('close'))
    expect(closes.map(invocation => invocation.argv).sort()).toEqual(started.map(session => ['--namespace', 'dsh', '--session', session, 'close']).sort())
    expect(ctx.tools.schemas()).toEqual([])
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name)).not.toContain('tool:browser')
  })

  it('unloads without starting a program when no browser was used, and survives a failed close', async () => {
    const idle = await setup()
    await idle.fiber.dispose()
    expect(await idle.invocations()).toEqual([])

    const broken = await setup({ closeTimeoutMs: 1_000 }, { program: () => { throw new ToolBrowser.BrowserToolError('no program', 'BROWSER_UNAVAILABLE') } })
    const unavailable = await call(broken.ctx, { commands: [['get', 'url']] })
    expect(unavailable.error?.info).toEqual({ name: 'BrowserToolError', code: 'BROWSER_UNAVAILABLE' })
    await expect(broken.fiber.dispose()).resolves.toBeUndefined()
  })
})

describe('browser tool configuration', () => {
  it('declares the schema, timeout, and a card title for the call', async () => {
    const { ctx } = await setup({ timeoutMs: 45_000 })
    const tool = ctx.tools.get('browser')
    expect(tool?.timeoutMs).toBe(45_000)
    expect(ctx.tools.schemas().map(schema => [schema.name, schema.parameters])).toEqual([['browser', {
      type: 'object',
      properties: {
        commands: {
          type: 'array',
          description: 'Browser commands in execution order. Each command is a list of strings: the command name, then each argument as its own string.',
          items: { type: 'array', items: { type: 'string' } },
        },
        headed: {
          type: 'boolean',
          description: 'true shows the browser window so the user can watch or act in it; false hides it. Omit to keep the current setting; changing it restarts the browser.',
        },
      },
      required: ['commands'],
    }]])
    expect(tool?.presentCall?.({ commands: [['open', 'https://example.test'], ['fill', '@e1', 'a b']] })).toEqual({
      card: 'generic',
      title: 'open https://example.test (+1 more)',
      kind: 'fetch',
      rawInput: 'open https://example.test\nfill @e1 "a b"',
    })
  })

  it.each([
    [{ maxCommands: 0 }, 'tool-browser: maxCommands must be a positive integer'],
    [{ timeoutMs: 1.5 }, 'tool-browser: timeoutMs must be a positive integer'],
    [{ maxResultChars: 0 }, 'tool-browser: maxResultChars must be a positive integer'],
    [{ maxOutputBytes: -1 }, 'tool-browser: maxOutputBytes must be a positive integer'],
    [{ stderrMaxBytes: 0 }, 'tool-browser: stderrMaxBytes must be a positive integer'],
    [{ graceMs: 0 }, 'tool-browser: graceMs must be a positive integer'],
    [{ closeTimeoutMs: 0 }, 'tool-browser: closeTimeoutMs must be a positive integer'],
    [{ graceMs: 2 ** 31 }, 'tool-browser: graceMs and closeTimeoutMs must be no greater than 2147483647'],
    [{ closeTimeoutMs: 2 ** 31 }, 'tool-browser: graceMs and closeTimeoutMs must be no greater than 2147483647'],
    [{ executablePath: 'chrome' }, 'tool-browser: executablePath must be absolute'],
    [{ browserArgs: ['lang=zh'] }, 'tool-browser: browserArgs entry "lang=zh" must start with a dash and contain no line break or ",-"'],
    [{ browserArgs: ['--a,--b'] }, 'tool-browser: browserArgs entry "--a,--b" must start with a dash and contain no line break or ",-"'],
    [{ browserArgs: ['--a\n--b'] }, 'tool-browser: browserArgs entry "--a\\n--b" must start with a dash and contain no line break or ",-"'],
  ])('rejects the configuration %j at load', (config, message) => {
    const ctx = new Context()
    expect(() => { ToolBrowser.apply(ctx, ToolBrowser.Config(config)) }).toThrow(message)
  })
})

describe('browser guidance', () => {
  /** Create a real per-agent scope over the mounted tool plugins. */
  async function guidanceScope(ctx: Context) {
    const key = {}
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['tools', 'systemPrompt'] }))
    return { key, scope }
  }

  const PLAIN: GuidanceFacts = { canReadImages: false, keepsLogins: false }

  it('teaches the commands while the tool is visible and says nothing once it is hidden', async () => {
    const { ctx } = await setup()
    const visible = renderPrompt(await ctx.systemPrompt.assemble())
    expect(visible).toContain(browserGuidance(PLAIN))
    expect(visible).not.toContain('read_image')

    ctx.tools.register({
      name: 'read_image', description: 'image fixture', parameters: {},
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: '' }] },
      execute: () => Promise.resolve(''),
    })
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain(browserGuidance({ ...PLAIN, canReadImages: true }))

    const { key, scope } = await guidanceScope(ctx)
    scope.ctx.tools.restrict({ deny: ['browser'] })
    try {
      expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))).not.toContain('Use the browser tool')
    } finally {
      await scope.dispose()
    }
  })

  it('names every working command group and the sign-in rules', () => {
    const guidance = browserGuidance({ canReadImages: true, keepsLogins: false })
    for (const command of [
      'open <url>', 'snapshot -i', 'click <sel>', 'fill <sel> <text>', 'type <sel> <text>', 'press <key>', 'select <sel> <value>',
      'check <sel>', 'upload <sel> <file>', 'find role <role> <action> --name <name>', 'wait --text <text>', 'tab new [url]',
      'dialog accept [text]', 'screenshot [file]', 'cookies', 'state save <file>', 'auth login <name>', 'headed: true',
    ]) expect(guidance).toContain(command)
    expect(guidance).toContain('Use read_image to look at a screenshot')
    expect(browserGuidance(PLAIN)).not.toContain('read_image')
    expect(guidance).not.toMatch(/\{\{|\}\}/u)
  })

  it('says whether logins survive a change of window visibility', async () => {
    const discarded = 'Changing it restarts the browser, which closes its pages and signs it out of every site, so choose it before signing in.'
    const kept = 'Changing it restarts the browser, which closes its pages; logins are kept.'
    expect(browserGuidance(PLAIN)).toContain(discarded)
    expect(browserGuidance(PLAIN)).not.toContain(kept)

    const { ctx } = await setup({ restore: 'session' })
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain(kept)
    expect(prompt).not.toContain(discarded)
  })
})

describe('dsh-tool-browser real-load-path guard', () => {
  it('has no default export and keeps name, inject, and Config through the Loader', async () => {
    expect('default' in ToolBrowser).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(ToolBrowser) as Record<string, unknown>
    expect(unwrapped).toBe(ToolBrowser)
    expect(unwrapped['name']).toBe('tool-browser')
    expect(unwrapped['inject']).toEqual(['tools', 'systemPrompt', 'subprocess'])
    expect(typeof unwrapped['Config']).toBe('function')

    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const fiber = await ctx.plugin(loader.unwrapExports(ToolBrowser) as Parameters<Context['plugin']>[0], {})
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['browser'])
    await fiber.dispose()
  })
})
