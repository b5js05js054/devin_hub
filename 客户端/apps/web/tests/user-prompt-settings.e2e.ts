/** General's saved user prompt in the Host profile, model requests, and the selected conversation. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { chromium, type Page } from 'playwright'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold, readPersistedEvents, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings, REPO_ROOT } from './support.ts'

const USER_PROMPT = '  Keep the exact label: orchid-712.\n\n第二行保留中文和标点。  '
const EXPECTED_PROMPT = {
  role: 'user', source: { kind: 'user-prompt', form: 'instructions' },
  content: [{ type: 'text', text: USER_PROMPT }],
}
const BODIES = [
  'Before setting a preference.',
  'First saved turn: 原文甲。',
  'Second saved turn: "B" & 2 < 3.',
  'After clearing the preference.',
] as const
// Four recorded, tool-free answers. The inputs and settings come from this browser session.
const FOUR_REPLIES = join(REPO_ROOT, 'snapshots/sdk/session-title-stability/session.v4.jsonl')

async function startPage(replayFixture?: string) {
  const scaffold = await launchWebScaffold(replayFixture === undefined ? {} : { replayFixture, compareReplaySession: false })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  page.setDefaultTimeout(10_000)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  return { scaffold, page }
}

async function openEditor(page: Page) {
  await openSettings(page, 'en')
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog.getByRole('button', { name: 'General', exact: true }).click()
  const field = dialog.getByRole('textbox', { name: 'User prompt', exact: true })
  await field.waitFor({ timeout: 5_000 })
  return { dialog, field }
}

async function storedPrompt(scaffold: WebScaffold): Promise<unknown> {
  const path = join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml')
  const rows = yaml.load(await readFile(path, 'utf8')) as { id?: string; config?: { userPrompt?: unknown } }[]
  const value = rows.find(row => row.id === 'ui-conversation')?.config?.userPrompt
  return value === undefined ? '' : value
}

async function changePrompt(page: Page, scaffold: WebScaffold, previous: string, value: string) {
  const { dialog, field } = await openEditor(page)
  await expect.poll(() => field.inputValue(), { timeout: 5_000 }).toBe(previous)
  await field.fill(value)
  const [reply] = await Promise.all([
    page.waitForResponse((response) => {
      if (response.request().method() !== 'POST' || new URL(response.url()).pathname !== '/api/settings/mutate') return false
      const { payload } = response.request().postDataJSON() as { payload: { args: { ns: string } } }
      return payload.args.ns === 'ui-conversation'
    }),
    dialog.getByRole('button', { name: 'Save', exact: true }).click(),
  ])
  expect(await reply.json()).toMatchObject({ result: { ok: true } })
  expect(await storedPrompt(scaffold)).toBe(value)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
}

function humanMessages(messages: readonly RequestMessage[]) {
  return messages.filter(message => message.source?.kind === 'user').map(({ role, content }) => ({ role, content }))
}

function promptMessages(messages: readonly RequestMessage[]) {
  // Include empty preference records and copies accidentally added to a different message.
  return messages.filter(message => message.source?.kind === EXPECTED_PROMPT.source.kind
    || message.content.some(block => block.type === 'text' && block.text.includes(USER_PROMPT.trim())))
}

function privilegedContent(request: GenerateOptions) {
  return {
    system: request.system,
    messages: request.messages.filter(message => message.role === 'system' || message.role === 'developer')
      .map(({ role, content }) => ({ role, content })),
  }
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: user prompt settings', () => {
  it('persists multiline text from General and restores the empty value after clearing', async () => {
    const { page, scaffold } = await startPage()
    await changePrompt(page, scaffold, '', USER_PROMPT)
    await page.reload({ waitUntil: 'load' })
    await changePrompt(page, scaffold, USER_PROMPT, '')
    await page.reload({ waitUntil: 'load' })
    const { field } = await openEditor(page)
    await expect.poll(() => field.isEditable()).toBe(true)
    expect(await field.inputValue()).toBe('')
  })

  it('sends the prompt once per enabled human turn as user content and preserves that history after clearing', async () => {
    const { page, scaffold } = await startPage(FOUR_REPLIES)
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const requests: GenerateOptions[] = []
    const off = scaffold.ctx.on('llm/stream', async function* (request, next) {
      if (request.purpose === undefined) requests.push(request)
      yield* next()
    })
    onTestFinished(() => { off() })
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    const userRows = page.locator('[data-chat-flow-kind="user"]')
    const send = async (body: string) => {
      await composer.fill(body)
      const [id] = await Promise.all([scaffold.whenTurnSettled(15_000), composer.press('Enter')])
      await userRows.getByText(body, { exact: true }).waitFor()
      return id
    }

    const sessionId = await send(BODIES[0])
    await changePrompt(page, scaffold, '', USER_PROMPT)
    await page.reload({ waitUntil: 'load' })
    await userRows.getByText(BODIES[0], { exact: true }).waitFor()
    expect(await send(BODIES[1])).toBe(sessionId)
    expect(await send(BODIES[2])).toBe(sessionId)
    await changePrompt(page, scaffold, USER_PROMPT, '')
    expect(await send(BODIES[3])).toBe(sessionId)

    const events = await readPersistedEvents(scaffold, sessionId)
    const durable = events.filter(event => event.type === 'user/message').map(event => event.data)
    const bodies = BODIES.map(text => ({ role: 'user', content: [{ type: 'text', text }] }))
    expect(humanMessages(durable)).toEqual(bodies)
    const prompts = promptMessages(durable)
    expect(prompts).toMatchObject([EXPECTED_PROMPT, EXPECTED_PROMPT])
    expect(new Set(prompts.map(prompt => prompt.id)).size).toBe(2)

    expect(requests.map(request => request.sessionId)).toEqual(BODIES.map(() => sessionId))
    expect(requests.map(request => promptMessages(request.messages))).toEqual([[], prompts.slice(0, 1), prompts, prompts])
    const initialInstructions = privilegedContent(requests[0]!)
    for (const [index, request] of requests.entries()) {
      expect(privilegedContent(request)).toEqual(initialInstructions)
      expect(humanMessages(request.messages)).toEqual(bodies.slice(0, index + 1))
    }
    await page.reload({ waitUntil: 'load' })
    for (const body of BODIES) await userRows.getByText(body, { exact: true }).waitFor()
  })
})
