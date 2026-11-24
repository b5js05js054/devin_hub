/** Backend-published release lookup and its native prompt flow, exercised through injected effects. */
import { describe, expect, it, vi } from 'vitest'
import { en, zh, type DesktopMessages } from '../src/locale.ts'
import { isNewerRelease, parseRelayUpdateLookup, type RelayUpdate, type RelayUpdateLookup } from '../src/relay-update.ts'
import { DesktopRelayUpdateFlow, type RelayUpdateFlowHost } from '../src/relay-update-flow.ts'
import type { UpdateDialogOptions } from '../src/update-dialog.ts'

const release: RelayUpdate = {
  version: '1.2.0', url: 'https://downloads.example.com/BaiLan-Setup-1.2.0.exe', sha256: '', mandatory: false, note: 'Faster startup',
}
const published: RelayUpdateLookup = { ok: true, update: release }
const none: RelayUpdateLookup = { ok: true, update: null }
const packageFile = 'C:\\Temp\\dsh-update-1\\BaiLan-Setup-1.2.0.exe'

/** One flow over recorded prompts; `answers` queues button indexes, an empty queue dismisses the prompt. */
function fixture(lookup: RelayUpdateLookup | Error | Promise<RelayUpdateLookup>, messages: DesktopMessages = en) {
  const dialogs: UpdateDialogOptions[] = []
  const notices: { readonly options: UpdateDialogOptions; closed: boolean }[] = []
  const answers: number[] = []
  const host = {
    lookup: vi.fn(async (): Promise<RelayUpdateLookup> => {
      if (lookup instanceof Error) throw lookup
      return lookup
    }),
    installedVersion: () => '1.1.0',
    messages: () => messages,
    show: vi.fn(async (options: UpdateDialogOptions) => {
      dialogs.push(options)
      return { response: answers.shift() ?? options.cancelId ?? 0 }
    }),
    notice: vi.fn((options: UpdateDialogOptions) => {
      const entry = { options, closed: false }
      notices.push(entry)
      return async () => { entry.closed = true }
    }),
    download: vi.fn(async (_update: RelayUpdate) => packageFile),
    install: vi.fn(async (_file: string) => {}),
  } satisfies RelayUpdateFlowHost
  return { flow: new DesktopRelayUpdateFlow(host), host, dialogs, notices, answers }
}

describe('backend release lookup decoding', () => {
  it('decodes a published release, an absent release, and a Host failure', () => {
    expect(parseRelayUpdateLookup({ ok: true, update: { ...release, extra: 1 } })).toEqual(published)
    expect(parseRelayUpdateLookup({ ok: true, update: null })).toEqual(none)
    expect(parseRelayUpdateLookup({ ok: false, code: 'signed-out', message: 'signed-out' }))
      .toEqual({ ok: false, code: 'signed-out', message: 'signed-out' })
  })

  it.each([
    null, 'text', {}, { ok: true }, { ok: false }, { ok: false, code: 7, message: 'x' },
    { ok: true, update: { ...release, version: 'latest' } },
    { ok: true, update: { version: '1.2.0', url: release.url } },
    { ok: true, update: { ...release, mandatory: 'yes' } },
  ])('reads the undecodable answer %j as a failed lookup, never as "no release"', (value) => {
    expect(parseRelayUpdateLookup(value)).toMatchObject({ ok: false, code: 'invalid-response' })
  })

  it('compares dotted versions numerically and ignores the installed prerelease suffix', () => {
    expect(isNewerRelease('1.2.0', '1.1.9')).toBe(true)
    expect(isNewerRelease('1.10', '1.9.5')).toBe(true)
    expect(isNewerRelease('1.0.0.1', '1.0.0')).toBe(true)
    expect(isNewerRelease('0.2.3', '0.2.2-rc.6')).toBe(true)
    expect(isNewerRelease('1.2', '1.2.0')).toBe(false)
    expect(isNewerRelease('0.2.2', '0.2.2-rc.6')).toBe(false)
    expect(isNewerRelease('1.1.0', '1.2.0')).toBe(false)
  })
})

describe('automatic backend release check', () => {
  it.each([
    ['no release is published', none],
    ['the published release is the installed one', { ok: true, update: { ...release, version: '1.1.0' } }],
    ['the published release is older', { ok: true, update: { ...release, version: '1.0.9' } }],
    ['the account is signed out', { ok: false, code: 'signed-out', message: 'signed-out' }],
    ['the workspace service is unavailable', new Error('desktop update: the workspace service is not ready')],
  ] as const)('stays silent when %s', async (_name, lookup) => {
    const { flow, host, dialogs, notices } = fixture(lookup)
    await flow.check()
    expect(host.lookup).toHaveBeenCalledOnce()
    expect(dialogs).toEqual([])
    expect(notices).toEqual([])
    expect(host.download).not.toHaveBeenCalled()
  })

  it('offers a newer release and installs it once the user accepts', async () => {
    const { flow, host, dialogs, notices, answers } = fixture(published)
    answers.push(0)
    await flow.check()
    expect(dialogs).toEqual([{
      type: 'info', title: en.relayUpdateTitle, message: 'Version 1.2.0 is available', detail: 'Faster startup',
      buttons: [en.relayUpdateInstall, en.later], cancelId: 1,
    }])
    expect(host.download).toHaveBeenCalledExactlyOnceWith(release)
    expect(host.install).toHaveBeenCalledExactlyOnceWith(packageFile)
    // The download gives no other sign of life, so a notice covers it and closes with it.
    expect(notices.map(entry => [entry.options.message, entry.options.detail, entry.closed]))
      .toEqual([[en.relayUpdateDownloading, en.relayUpdateDownloadingDetail, true]])
  })

  it('does not offer a declined release again until the user asks', async () => {
    const { flow, host, dialogs } = fixture(published)
    await flow.check()
    await flow.check()
    expect(host.lookup).toHaveBeenCalledTimes(2)
    expect(dialogs).toHaveLength(1)
    expect(host.download).not.toHaveBeenCalled()
    await flow.check(true)
    expect(dialogs).toHaveLength(2)
    expect(dialogs[1]!.message).toBe('Version 1.2.0 is available')
  })

  it('offers a later release after an earlier one was declined', async () => {
    const lookups: RelayUpdateLookup[] = [published, { ok: true, update: { ...release, version: '1.3.0' } }]
    const { flow, host, dialogs } = fixture(published)
    host.lookup.mockImplementation(async () => lookups.shift()!)
    await flow.check()
    await flow.check()
    expect(dialogs.map(dialog => dialog.message)).toEqual(['Version 1.2.0 is available', 'Version 1.3.0 is available'])
  })

  it('leaves a mandatory release no way to decline: one button, and dismissal starts the download', async () => {
    const { flow, host, dialogs } = fixture({ ok: true, update: { ...release, mandatory: true } })
    await flow.check()
    expect(dialogs[0]).toMatchObject({
      message: 'Version 1.2.0 is available and required', buttons: [en.relayUpdateInstall], cancelId: 0,
    })
    expect(host.download).toHaveBeenCalledOnce()
    expect(host.install).toHaveBeenCalledExactlyOnceWith(packageFile)
    await flow.check()
    expect(dialogs).toHaveLength(2)
  })

  it.each([
    ['the download or its checksum fails', 'download', 'desktop update: package checksum mismatch'],
    ['the installer cannot be started', 'install', 'The system cannot find the file specified.'],
  ] as const)('reports the failure and keeps running when %s', async (_name, step, reason) => {
    const { flow, host, dialogs, notices, answers } = fixture(published)
    answers.push(0)
    host[step].mockRejectedValueOnce(new Error(reason))
    await flow.check()
    expect(dialogs[1]).toEqual({
      type: 'error', title: en.relayUpdateTitle, message: en.relayUpdateDownloadFailed, detail: reason,
      buttons: [en.later], cancelId: 0,
    })
    expect(notices.every(entry => entry.closed)).toBe(true)
    if (step === 'download') expect(host.install).not.toHaveBeenCalled()
  })

  it('never rejects, also when a prompt cannot be shown', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { flow, host } = fixture(published)
      host.show.mockRejectedValueOnce(new Error('window destroyed'))
      await expect(flow.check()).resolves.toBeUndefined()
      expect(report).toHaveBeenCalledOnce()
      // The failed check does not block the next one.
      await flow.check()
      expect(host.lookup).toHaveBeenCalledTimes(2)
    } finally {
      report.mockRestore()
    }
  })
})

describe('manual backend release check', () => {
  it('answers "up to date" with the installed version behind a checking notice', async () => {
    const { flow, dialogs, notices } = fixture(none)
    await flow.check(true)
    expect(notices.map(entry => [entry.options.title, entry.options.message, entry.options.buttons, entry.closed]))
      .toEqual([[en.updateCheckTitle, en.updateChecking, [en.later], true]])
    expect(dialogs).toEqual([{
      type: 'info', title: en.updateCheckTitle, message: en.updateCurrent, detail: 'Current version: 1.1.0',
    }])
  })

  it('offers a newer release without a second lookup', async () => {
    const { flow, host, dialogs, answers } = fixture(published)
    answers.push(0)
    await flow.check(true)
    expect(host.lookup).toHaveBeenCalledOnce()
    expect(dialogs.map(dialog => dialog.message)).toEqual(['Version 1.2.0 is available'])
    expect(host.install).toHaveBeenCalledExactlyOnceWith(packageFile)
  })

  it.each([
    ['signed-out', 'signed-out', en.updateCheckSignedOut, 'desktop update: backend release lookup failed (signed-out)'],
    ['unauthorized', 'unauthorized', en.updateCheckSignedOut, 'desktop update: backend release lookup failed (unauthorized)'],
    ['network', 'connect ECONNREFUSED 127.0.0.1:8000', en.updateCheckNetworkFailed,
      'desktop update: backend release lookup failed (network): connect ECONNREFUSED 127.0.0.1:8000'],
    ['rejected', 'HTTP 502', en.updateCheckFailed, 'desktop update: backend release lookup failed (rejected): HTTP 502'],
    ['not-configured', 'not-configured', en.updateCheckFailed, 'desktop update: backend release lookup failed (not-configured)'],
    ['invalid-response', '', en.updateCheckFailed, 'desktop update: backend release lookup failed (invalid-response)'],
  ] as const)('explains a %s lookup failure', async (code, message, summary, technicalDetails) => {
    const { flow, host, dialogs } = fixture({ ok: false, code, message })
    await flow.check(true)
    expect(dialogs).toEqual([{ type: 'error', title: en.updateFailedTitle, message: summary, technicalDetails }])
    expect(host.download).not.toHaveBeenCalled()
  })

  it('reports an unavailable workspace service as a failed check', async () => {
    const { flow, dialogs, notices } = fixture(new Error('desktop update: the workspace service is not ready'))
    await flow.check(true)
    expect(dialogs).toEqual([{
      type: 'error', title: en.updateFailedTitle, message: en.updateCheckFailed,
      technicalDetails: 'desktop update: the workspace service is not ready',
    }])
    expect(notices.every(entry => entry.closed)).toBe(true)
  })

  it('joins an automatic check in flight and still gets an answer', async () => {
    let settle!: (value: RelayUpdateLookup) => void
    const { flow, host, dialogs } = fixture(new Promise<RelayUpdateLookup>((resolve) => { settle = resolve }))
    const automatic = flow.check()
    const manual = flow.check(true)
    settle(none)
    await Promise.all([automatic, manual])
    expect(host.lookup).toHaveBeenCalledOnce()
    expect(dialogs.map(dialog => dialog.message)).toEqual([en.updateCurrent])
    // The answer belongs to that one request: the next automatic check is silent again.
    await flow.check()
    expect(dialogs).toHaveLength(1)
  })

  it('reads the shell language for every prompt', async () => {
    const { flow, dialogs, notices, answers } = fixture(published, zh)
    answers.push(1)
    await flow.check(true)
    expect(notices[0]!.options.message).toBe('正在检查更新…')
    expect(dialogs[0]).toMatchObject({ title: '发现新版本', message: '新版本 1.2.0 已发布', buttons: ['下载并安装', '稍后'] })
  })
})
