import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BrowserToolError } from '../src/errors.ts'
import { anchorSavedPaths, displayCommand, parseBatchReport, renderOutput, summarizeCommands } from '../src/render.ts'

const lifecycle = { launched: false, relaunchedBrowser: false, reused: true }

function report(rows: unknown): string {
  return JSON.stringify(rows)
}

describe('parseBatchReport', () => {
  it('keeps page data, drops launch bookkeeping, and counts commands skipped after a failure', () => {
    expect(parseBatchReport(report([
      { command: ['open', 'https://example.com'], success: true, error: null, result: { lifecycle, title: 'Example', url: 'https://example.com/' } },
      { command: ['get', 'count', 'a'], success: true, error: null, result: 3 },
      { command: ['press', 'Enter'], success: true, error: null, result: null },
      { command: ['focus', '@e1'], success: true, error: null },
      { command: ['click', '@e9'], success: false, error: 'Unknown ref: e9', result: null },
    ]), 7)).toEqual({
      results: [
        { command: ['open', 'https://example.com'], success: true, result: { title: 'Example', url: 'https://example.com/' } },
        { command: ['get', 'count', 'a'], success: true, result: 3 },
        { command: ['press', 'Enter'], success: true },
        { command: ['focus', '@e1'], success: true },
        { command: ['click', '@e9'], success: false, error: 'Unknown ref: e9' },
      ],
      skipped: 2,
    })
  })

  it('keeps a snapshot as its text, without the ref tables that repeat it', () => {
    expect(parseBatchReport(report([
      {
        command: ['snapshot', '-i'],
        success: true,
        error: null,
        result: { lifecycle, origin: 'https://example.com', refs: { e1: { name: 'Sign in', role: 'button' } }, removedRefs: ['@e2'], snapshot: '- button "Sign in" [ref=e1]' },
      },
      // Outside a snapshot the same key is page data.
      { command: ['eval', '({ refs: 1 })'], success: true, error: null, result: { lifecycle, refs: 1 } },
    ]), 2)).toEqual({
      results: [
        { command: ['snapshot', '-i'], success: true, result: { origin: 'https://example.com', snapshot: '- button "Sign in" [ref=e1]' } },
        { command: ['eval', '({ refs: 1 })'], success: true, result: { refs: 1 } },
      ],
      skipped: 0,
    })
  })

  it('reports a browser restart and keeps failure data', () => {
    expect(parseBatchReport(report([
      { command: ['get', 'url'], success: true, error: null, result: { lifecycle: { ...lifecycle, relaunchedBrowser: true }, url: 'about:blank' } },
      { command: ['open', 'https://example.com'], success: false, error: null, result: { lifecycle: { settings: {} } } },
    ]), 2)).toEqual({
      results: [
        { command: ['get', 'url'], success: true, result: { url: 'about:blank', browserRestarted: true } },
        { command: ['open', 'https://example.com'], success: false, error: 'the command failed without a message', result: {} },
      ],
      skipped: 0,
    })
  })

  it.each([
    ['', 'the browser returned output that is not a result report'],
    ['✓ Browser closed', 'the browser returned output that is not a result report'],
    ['{"success":true}', 'the browser returned a result report that does not match the submitted commands'],
    [report([{ command: ['a'], success: true }, { command: ['b'], success: true }]), 'the browser returned a result report that does not match the submitted commands'],
    [report([null]), 'the browser returned a malformed result for command 1'],
    [report([{ command: ['a'], success: 'yes' }]), 'the browser returned a malformed result for command 1'],
    [report([{ command: 'a', success: true }]), 'the browser returned a malformed result for command 1'],
    [report([{ command: ['a', 1], success: true }]), 'the browser returned a malformed result for command 1'],
  ])('rejects the output %j', (stdout, message) => {
    expect(() => parseBatchReport(stdout, 1)).toThrow(new BrowserToolError(message, 'BROWSER_FAILED'))
  })
})

describe('anchorSavedPaths', () => {
  it('resolves a relative saved path against the output directory and leaves other results alone', () => {
    const directory = join(process.cwd(), 'browser-output')
    const absolute = join(process.cwd(), 'elsewhere', 'page.png')
    expect(anchorSavedPaths({
      results: [
        { command: ['screenshot', 'shot.png'], success: true, result: { path: 'shot.png' } },
        { command: ['screenshot', absolute], success: true, result: { path: absolute } },
        { command: ['screenshot'], success: true, result: { path: '/tmp/posix.png' } },
        { command: ['screenshot'], success: true, result: { path: 'C:\\tmp\\windows.png' } },
        { command: ['get', 'title'], success: true, result: { title: 'x' } },
        { command: ['eval', '1'], success: true, result: 'path' },
        { command: ['press', 'Enter'], success: true },
        { command: ['get', 'attr', '@e1', 'href'], success: true, result: { path: 7 } },
      ],
      skipped: 1,
    }, directory)).toEqual({
      results: [
        { command: ['screenshot', 'shot.png'], success: true, result: { path: join(directory, 'shot.png') } },
        { command: ['screenshot', absolute], success: true, result: { path: absolute } },
        { command: ['screenshot'], success: true, result: { path: '/tmp/posix.png' } },
        { command: ['screenshot'], success: true, result: { path: 'C:\\tmp\\windows.png' } },
        { command: ['get', 'title'], success: true, result: { title: 'x' } },
        { command: ['eval', '1'], success: true, result: 'path' },
        { command: ['press', 'Enter'], success: true },
        { command: ['get', 'attr', '@e1', 'href'], success: true, result: { path: 7 } },
      ],
      skipped: 1,
    })
  })
})

describe('renderOutput', () => {
  it('renders one block per command', () => {
    expect(renderOutput({
      results: [
        { command: ['open', 'https://example.com'], success: true, result: { targetId: 'T1', title: 'Example Domain', url: 'https://example.com/' } },
        { command: ['snapshot', '-i'], success: true, result: { origin: 'https://example.com', refs: { e1: { name: 'Learn more', role: 'link' } }, snapshot: '- link "Learn more" [ref=e1]' } },
        { command: ['snapshot', '-s', '#none'], success: true, result: { refs: {}, snapshot: '' } },
        { command: ['fill', '@e3', 'two words'], success: true, result: {} },
        { command: ['fill', '@e4', ''], success: true },
        { command: ['eval', 'document.title'], success: true, result: 'Example Domain' },
        { command: ['get', 'count', 'a'], success: true, result: 3 },
        { command: ['tab'], success: true, result: [{ id: 't1' }] },
        { command: ['get', 'box', '@e1'], success: true, result: { box: { x: 1, y: 2 }, visible: true } },
        { command: ['get', 'url'], success: true, result: { url: 'about:blank', browserRestarted: true } },
        { command: ['click', '@e9'], success: false, error: 'Unknown ref: e9' },
      ],
      skipped: 0,
      files: [],
    }, 1_000)).toBe([
      '$ open https://example.com\ntitle: Example Domain\nurl: https://example.com/',
      '$ snapshot -i\n- link "Learn more" [ref=e1]',
      '$ snapshot -s #none\n(the page has no matching elements)',
      '$ fill @e3 "two words"\nok',
      '$ fill @e4 ""\nok',
      '$ eval document.title\nExample Domain',
      '$ get count a\n3',
      '$ tab\n[{"id":"t1"}]',
      '$ get box @e1\nbox: {"x":1,"y":2}\nvisible: true',
      '$ get url\nnote: the browser restarted for this command; pages and logins from before are gone\nurl: about:blank',
      '$ click @e9\nError: Unknown ref: e9',
    ].join('\n\n'))
  })

  it('bounds each command body separately and names the commands that did not run', () => {
    const text = renderOutput({
      results: [
        { command: ['snapshot'], success: true, result: { snapshot: 'a'.repeat(30) } },
        { command: ['get', 'title'], success: true, result: { title: 'short' } },
        { command: ['click', '@e9'], success: false, error: 'b'.repeat(25) },
      ],
      skipped: 2,
      files: [],
    }, 20)
    expect(text).toBe([
      `$ snapshot\n${'a'.repeat(20)}\n[10 more characters omitted; narrow the request, for example with snapshot -i, snapshot -s <selector>, or get text <selector>]`,
      '$ get title\ntitle: short',
      `$ click @e9\nError: ${'b'.repeat(13)}\n[12 more characters omitted; narrow the request, for example with snapshot -i, snapshot -s <selector>, or get text <selector>]`,
      '(2 later commands were not run)',
    ].join('\n\n'))
    expect(renderOutput({ results: [{ command: ['back'], success: false, error: 'no history' }], skipped: 1, files: [] }, 100))
      .toBe('$ back\nError: no history\n\n(1 later command was not run)')
  })

  it('lists the labels of an annotated screenshot by ref', () => {
    expect(renderOutput({
      results: [{
        command: ['screenshot', 'page.png'],
        success: true,
        result: {
          annotations: [
            { box: { x: 8, y: 21, width: 120, height: 46 }, name: 'Sign in', number: 1, ref: 'e1', role: 'button' },
            { box: { x: 8, y: 80, width: 120, height: 20 }, name: '', number: 2, ref: 'e2', role: 'textbox' },
            'unlabelled',
          ],
          path: '/out/page.png',
        },
      }],
      skipped: 0,
      files: ['/out/page.png'],
    }, 1_000)).toBe('$ screenshot page.png\nlabels drawn on the image:\n  [1] @e1 button "Sign in"\n  [2] @e2 textbox ""\n  unlabelled\npath: /out/page.png')
  })

  it('lists saved files that no command result names', () => {
    expect(renderOutput({
      results: [
        { command: ['screenshot', 'page.png'], success: true, result: { path: '/out/page.png' } },
        { command: ['click', '@e7'], success: true, result: { clicked: '@e7' } },
        { command: ['back'], success: false, error: 'no history' },
      ],
      skipped: 1,
      files: ['/out/page.png', '/out/report.pdf', '/out/sheet.xlsx'],
    }, 1_000)).toBe([
      '$ screenshot page.png\npath: /out/page.png',
      '$ click @e7\nclicked: @e7',
      '$ back\nError: no history',
      '(1 later command was not run)',
      'Saved files:\n/out/report.pdf\n/out/sheet.xlsx',
    ].join('\n\n'))
  })
})

describe('command display', () => {
  it('quotes only arguments whose extent is ambiguous', () => {
    expect(displayCommand(['fill', '@e1', 'a b', '', 'tab\there'])).toBe('fill @e1 "a b" "" "tab\\there"')
  })

  it('titles a call by its first command', () => {
    expect(summarizeCommands([['open', 'https://example.com']])).toBe('open https://example.com')
    expect(summarizeCommands([['open', 'https://example.com'], ['snapshot', '-i'], ['get', 'title']])).toBe('open https://example.com (+2 more)')
    expect(summarizeCommands([])).toBe('browser')
  })
})
