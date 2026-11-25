// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as applySettings, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '../src/client/apply.ts'
import { ConversationSettingsSchema } from '../src/submission-settings.ts'

usePinnedBrowserLanguages('en-US')

function section(userPrompt: string, revision = 1) {
  return {
    ns: 'ui-conversation', schema: ConversationSettingsSchema.toJSON(),
    value: { busyEnter: 'steer', userPrompt }, revision,
    secrets: [], autoGenerate: true, applies: 'live',
  }
}

function documentWith(userPrompt: string, revision = 1, writable = true) {
  return { ok: true, value: { writable, hasDocument: true, namespaces: [section(userPrompt, revision)] } }
}

async function mount(initial: Promise<ReturnType<typeof documentWith>> = Promise.resolve(documentWith('From the Host'))) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const describe = vi.fn().mockReturnValue(initial)
  const mutate = vi.fn()
  runtime.remote.provideNamespaces({ settings: { describe, mutate } })
  await runtime.mount({ inject: [...settingsInject], apply: applySettings })
  runtime.ctx.provide('uiWorkspace', { openWorkspace: vi.fn(), openSession: vi.fn() } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.declare({
    'settings.general.item': { kind: 'list', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
  })
  await runtime.mount({ inject: [...inject], apply })
  runtime.renderSlot('shell.overlay', {})
  const row = runtime.renderSlot('settings.general.item', {})
  return { runtime, describe, mutate, row }
}

function prompt(label = 'User prompt'): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: label })
}

function save(label = 'Save'): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: label })
}

it('waits for Host settings before editing and reads the accepted prompt on reopen and reconnect', async () => {
  const initial = Promise.withResolvers<ReturnType<typeof documentWith>>()
  const { runtime, describe, mutate, row } = await mount(initial.promise)
  expect(prompt().disabled).toBe(true)
  expect(save().disabled).toBe(true)
  await act(async () => { initial.resolve(documentWith('Existing\nprompt')) })
  const textbox = prompt()
  expect(textbox).toBeInstanceOf(HTMLTextAreaElement)
  expect(textbox.labels?.[0]?.textContent).toBe('User prompt')
  expect(textbox.value).toBe('Existing\nprompt')
  const hint = document.getElementById(textbox.getAttribute('aria-describedby')!)?.textContent
  expect(hint).toMatch(/user message/i)
  expect(hint).toMatch(/clear.*save/i)
  fireEvent.change(textbox, { target: { value: 'Only a draft' } })
  fireEvent.blur(textbox)
  expect(mutate).not.toHaveBeenCalled()
  row.update({}, { only: 'composer-enter' })
  row.update({}, { only: 'user-prompt' })
  expect(prompt().value).toBe('Existing\nprompt')
  describe.mockResolvedValue(documentWith('From another client', 2))
  await act(async () => { runtime.ctx.emit('connection/reset') })
  expect(prompt().value).toBe('From another client')
  expect(mutate).not.toHaveBeenCalled()
})

it('saves an exact multiline value and clears only the prompt on the next explicit save', async () => {
  const { mutate, row } = await mount()
  const pending = Promise.withResolvers<{ ok: true; value: ReturnType<typeof section> }>()
  const text = '  First line\n\n第二行  '
  mutate.mockReturnValueOnce(pending.promise)
  fireEvent.change(prompt(), { target: { value: text } })
  expect(mutate).not.toHaveBeenCalled()
  fireEvent.click(save())
  expect(save('Saving…').disabled).toBe(true)
  row.update({}, { only: 'composer-enter' })
  row.update({}, { only: 'user-prompt' })
  expect(save('Saving…').disabled).toBe(true)
  fireEvent.click(save('Saving…'))
  await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
  expect(mutate).toHaveBeenCalledWith('ui-conversation', [{ op: 'set', path: ['userPrompt'], value: text }], 1)
  await act(async () => { pending.resolve({ ok: true, value: section(text, 2) }) })
  expect(await screen.findByText('User prompt saved')).toBeTruthy()
  expect(save().disabled).toBe(true)
  row.update({}, { only: 'composer-enter' })
  expect(screen.getByRole('button', { name: 'Steer' })).toBeTruthy()
  row.update({}, { only: 'user-prompt' })
  expect(prompt().value).toBe(text)
  mutate.mockResolvedValueOnce({ ok: true, value: section('', 3) })
  fireEvent.change(prompt(), { target: { value: '' } })
  expect(mutate).toHaveBeenCalledTimes(1)
  fireEvent.click(save())
  await waitFor(() => { expect(save().disabled).toBe(true) })
  expect(mutate).toHaveBeenNthCalledWith(2, 'ui-conversation', [{ op: 'set', path: ['userPrompt'], value: '' }], 2)
  row.update({}, { only: 'composer-enter' })
  row.update({}, { only: 'user-prompt' })
  expect(prompt().value).toBe('')
})

it.each(['refused', 'disconnected'])('retains a draft after a %s save and accepts an explicit retry', async (failure) => {
  const { describe, mutate } = await mount()
  if (failure === 'refused') {
    describe.mockResolvedValue(documentWith('Another saved value', 2))
    mutate.mockResolvedValueOnce({ ok: false, error: { message: 'revision conflict' } })
  } else {
    mutate.mockRejectedValueOnce(new Error('Disconnected'))
  }
  fireEvent.change(prompt(), { target: { value: 'Keep my\ndraft' } })
  fireEvent.click(save())
  expect(await screen.findByText(/could not save.*try again/i)).toBeTruthy()
  expect(screen.queryByText('User prompt saved')).toBeNull()
  expect(prompt().value).toBe('Keep my\ndraft')
  expect(save().disabled).toBe(false)
  mutate.mockResolvedValueOnce({ ok: true, value: section('Keep my\ndraft', 3) })
  fireEvent.click(save())
  expect(await screen.findByText('User prompt saved')).toBeTruthy()
  expect(prompt().value).toBe('Keep my\ndraft')
  expect(save().disabled).toBe(true)
})

it('can retry an initial read failure without writing the blank field', async () => {
  const initial = Promise.withResolvers<ReturnType<typeof documentWith>>()
  const { describe, mutate } = await mount(initial.promise)
  await act(async () => { initial.reject(new Error('Disconnected')) })
  expect(prompt().disabled).toBe(true)
  expect(save().disabled).toBe(true)
  describe.mockResolvedValue(documentWith('Recovered'))
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => { expect(prompt().value).toBe('Recovered') })
  expect(prompt().disabled).toBe(false)
  expect(mutate).not.toHaveBeenCalled()
})

it('localizes the editor and keeps read-only or unavailable Host settings from being written', async () => {
  const { runtime, describe, mutate } = await mount(Promise.resolve(documentWith('只读内容', 1, false)))
  act(() => { runtime.ctx.locale.setLocale('zh') })
  expect(prompt('用户提示词').value).toBe('只读内容')
  expect(prompt('用户提示词').disabled).toBe(true)
  expect(save('保存').disabled).toBe(true)
  expect(screen.getByRole('status').textContent).toMatch(/只读/)
  describe.mockResolvedValue({ ok: true, value: { writable: true, hasDocument: true, namespaces: [] } })
  await act(async () => { runtime.ctx.emit('connection/reset') })
  expect(screen.getByText(/不可用/)).toBeTruthy()
  expect(save('保存').disabled).toBe(true)
  expect(mutate).not.toHaveBeenCalled()
})
