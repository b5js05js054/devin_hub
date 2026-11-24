import { describe, expect, it } from 'vitest'
import { admitCommands, liftAnnotation } from '../src/commands.ts'
import { BrowserToolError } from '../src/errors.ts'

function rejection(run: () => unknown): { code: string; message: string } {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof BrowserToolError) return { code: error.code, message: error.message }
    throw error
  }
  throw new Error('expected the commands to be rejected')
}

describe('admitCommands', () => {
  it('admits page commands unchanged and drops a repeated program name', () => {
    expect(admitCommands([
      ['open', 'https://example.com'],
      ['agent-browser', 'snapshot', '-i'],
      ['fill', '@e3', 'two words'],
      ['fill', '@e4', '--', '-5'],
      ['close'],
      ['doctor'],
    ], 10, undefined)).toEqual([
      ['open', 'https://example.com'],
      ['snapshot', '-i'],
      ['fill', '@e3', 'two words'],
      ['fill', '@e4', '--', '-5'],
      ['close'],
      ['doctor'],
    ])
  })

  it('requires between one command and the configured limit', () => {
    expect(rejection(() => admitCommands([], 2, undefined))).toEqual({
      code: 'BROWSER_INVALID_COMMAND',
      message: 'commands must contain at least one command',
    })
    expect(rejection(() => admitCommands([['get', 'url'], ['get', 'title'], ['back']], 2, undefined))).toEqual({
      code: 'BROWSER_INVALID_COMMAND',
      message: 'commands accepts at most 2 commands per call, received 3; split the work across calls',
    })
    expect(admitCommands([['get', 'url'], ['get', 'title']], 2, undefined)).toHaveLength(2)
  })

  it.each([
    [[[]], 'command 1 is empty'],
    [[['open', 'https://example.com'], ['agent-browser']], 'command 2 is empty'],
    [[['  ', 'x']], 'command 1 is empty'],
    [[['--session', 'other', 'get', 'url']], 'command 1 starts with the option "--session"'],
    [[['-i']], 'command 1 starts with the option "-i"'],
  ])('rejects the malformed command list %j', (commands, message) => {
    const failure = rejection(() => admitCommands(commands, 10, undefined))
    expect(failure.code).toBe('BROWSER_INVALID_COMMAND')
    expect(failure.message).toContain(message)
  })

  it.each([
    ['install', 'installing a browser is a deployment task; ask the user to install Google Chrome or Microsoft Edge'],
    ['upgrade', 'the browser tool is updated together with the application'],
    ['connect', 'the tool controls only the browser it starts for this session'],
    ['batch', 'pass the commands directly in `commands`'],
    ['mcp', 'it does not operate a page'],
    ['chat', 'it does not operate a page'],
    ['dashboard', 'it does not operate a page'],
    ['stream', 'it does not operate a page'],
    ['plugin', 'it does not operate a page'],
    ['skills', 'it does not operate a page'],
  ])('denies the host command %s with its reason', (name, reason) => {
    expect(rejection(() => admitCommands([['get', 'url'], [name, 'x']], 10, undefined))).toEqual({
      code: 'BROWSER_COMMAND_DENIED',
      message: `command 2: "${name}" is not available through this tool: ${reason}`,
    })
  })

  it('denies options that reach past the session browser', () => {
    expect(rejection(() => admitCommands([['close', '--all']], 10, undefined))).toEqual({
      code: 'BROWSER_COMMAND_DENIED',
      message: 'command 1: "close --all" is not available through this tool: it would close browsers that belong to other sessions',
    })
    expect(rejection(() => admitCommands([['doctor', '--offline', '--fix']], 10, undefined))).toEqual({
      code: 'BROWSER_COMMAND_DENIED',
      message: 'command 1: "doctor --fix" is not available through this tool: repairs change the host installation',
    })
  })

  it.each([
    [['state', 'clear'], 'state clear'],
    [['state', 'clear', '--all'], 'state clear'],
    [['state', 'clean', '--older-than', '0'], 'state clean'],
    [['state', 'rename', 'a', 'b'], 'state rename'],
    [['state', 'list'], 'state list'],
    [['state', 'show', 'a.json'], 'state show'],
    [['state'], 'state'],
  ])('admits only the state operations of this session, denying %j', (command, form) => {
    expect(rejection(() => admitCommands([command], 10, undefined))).toEqual({
      code: 'BROWSER_COMMAND_DENIED',
      message: `command 1: "${form}" is not available through this tool: it manages the saved logins of every session. `
        + 'Use "state save <file>" or "state load <file>" for this session, and "cookies clear" to sign this session out',
    })
  })

  describe('file-saving commands under a confining sandbox mode', () => {
    const absolute = process.platform === 'win32' ? 'C:\\Users\\me\\shot.png' : '/home/me/shot.png'

    it.each([
      ['screenshot', absolute],
      ['screenshot', '--full', '/tmp/shot.png'],
      ['screenshot', 'C:\\out\\shot.png'],
      ['screenshot', '..\\outside.png'],
      ['pdf', '../outside.pdf'],
      ['download', '@e1', '/tmp/file.zip'],
      ['trace', 'stop', '/tmp/trace.zip'],
      ['profiler', 'stop', '/tmp/profile.json'],
      ['record', 'start', '/tmp/video.webm'],
      ['state', 'save', '/tmp/auth.json'],
      ['network', 'har', 'stop', '/tmp/out.har'],
      ['wait', '--download', '/tmp/file.zip'],
    ])('denies %j', (...command) => {
      for (const mode of ['read-only', 'workspace-write'] as const) {
        const failure = rejection(() => admitCommands([command], 10, mode))
        expect(failure.code).toBe('BROWSER_SANDBOX_DENIED')
        expect(failure.message).toContain(`[sandbox: file access denied under ${mode} mode]`)
        expect(failure.message).toContain(`command 1: "${command[0]}" may not save to`)
      }
    })

    it.each([
      [['screenshot']],
      [['screenshot', '--full', 'page.png']],
      [['pdf', 'report.pdf']],
      [['download', '@e1', 'file.zip']],
      [['state', 'save', 'auth.json']],
      // Commands that read a file, or take a path-like argument without saving, are not file output.
      [['state', 'load', '/tmp/auth.json']],
      [['network', 'route', 'https://example.com/a/../b']],
      [['wait', '--url', '**/dashboard']],
      [['upload', '@e2', '/tmp/photo.png']],
      [['open', 'https://example.com/../x']],
    ])('admits %j', (command) => {
      expect(admitCommands([command], 10, 'read-only')).toEqual([command])
    })

    it('leaves every path to the caller under danger-full-access and without a sandbox policy', () => {
      const command = ['screenshot', absolute]
      expect(admitCommands([command], 10, 'danger-full-access')).toEqual([command])
      expect(admitCommands([command], 10, undefined)).toEqual([command])
    })
  })
})

describe('liftAnnotation', () => {
  it('moves the annotation option of a screenshot out of the command', () => {
    expect(liftAnnotation([['open', 'https://example.com'], ['screenshot', '--annotate', 'page.png'], ['screenshot', '--full']])).toEqual({
      commands: [['open', 'https://example.com'], ['screenshot', 'page.png'], ['screenshot', '--full']],
      annotate: true,
    })
  })

  it('leaves commands alone when no screenshot asks for annotation', () => {
    // Outside a screenshot the same text is an argument of that command.
    const commands = [['screenshot', 'page.png'], ['fill', '@e1', '--', '--annotate']]
    expect(liftAnnotation(commands)).toEqual({ commands, annotate: false })
  })
})
