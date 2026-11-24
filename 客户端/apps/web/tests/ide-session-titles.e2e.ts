/** First prompts name all IDE Agent tabs and remain visible in ordinary Session history. */
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/deepseek-messages-chat/session.v3.jsonl', import.meta.url))
const PROMPTS = ['Inspect login redirects', 'Review query performance', 'Plan browser coverage'] as const

describe.skipIf(webSnapshotMode() === 'record')('web e2e: IDE Session titles', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      // Each independent Session consumes the same recorded, tool-free reply.
      replayChildFixtures: [FIXTURE, FIXTURE],
      compareReplaySession: false,
      replayProviders: [{
        id: 'deepseek-messages', name: 'DeepSeek',
        models: [{
          id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash',
          contextWindow: 1_000_000, defaultMaxTokens: 256_000,
          reasoningEfforts: ['off', 'low', 'high', 'max'], defaultReasoningEffort: 'high',
        }],
      }],
    })
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'deepseek-messages', model: 'deepseek-v4-flash' })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    page.on('pageerror', (error) => { console.error('[IDE title e2e pageerror]', error.stack ?? String(error)) })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('uses each first prompt in its Agent tab and the sidebar after leaving IDE', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ide-session-titles'))
    await page.getByRole('button', { name: 'IDE', exact: true }).click()
    const ide = page.locator('[data-ide]')
    await ide.waitFor({ timeout: 15_000 })
    const tabs = ide.getByRole('tablist', { name: 'Agent conversations', exact: true })
    const sessionIds: string[] = []

    for (const [index, prompt] of PROMPTS.entries()) {
      if (index > 0) await tabs.getByRole('button', { name: 'New Agent conversation', exact: true }).click()
      const tab = tabs.getByRole('tab').nth(index)
      await expect.poll(() => tabs.getByRole('tab').count(), { timeout: 10_000 }).toBe(index + 1)
      await expect.poll(() => tab.getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')
      expect(await tab.locator('span').first().textContent()).toBe(`Agent ${index + 1}`)

      const input = ide.locator('[data-composer-input]:visible')
      await writeComposerDraft(page, input, prompt)
      const settled = scaffold.whenTurnSettled()
      await input.press('Enter')
      const sessionId = await settled
      sessionIds.push(sessionId)
      const session = scaffold.ctx.sessions.get(sessionId)
      if (session === undefined) throw new Error(`IDE Agent Session ${sessionId} is not live`)
      // The scaffold disables LLM titles; the real first-prompt fallback remains active.
      await expect.poll(() => scaffold.ctx.sessionTitle.get(session), { timeout: 10_000 })
        .toMatchObject({ title: prompt, source: { kind: 'fallback' } })
      await expect.poll(() => tab.locator('span').first().textContent(), { timeout: 10_000 }).toBe(prompt)
      await ide.getByText('MESSAGES_WEB_READY', { exact: true }).and(page.locator(':visible')).waitFor({ timeout: 10_000 })
    }

    expect(new Set(sessionIds).size).toBe(3)
    // Every tab keeps its own title while another Agent is selected.
    const tabTitles = await tabs.getByRole('tab').locator('span:first-child').allTextContents()
    expect(tabTitles).toEqual([...PROMPTS])
    await tabs.getByRole('tab').nth(1).click()
    await expect.poll(() => tabs.getByRole('tab').nth(1).getAttribute('aria-selected')).toBe('true')
    await ide.locator('[data-composer-input]:visible').waitFor()
    expect(await tabs.getByRole('tab').nth(2).locator('span').first().textContent()).toBe(PROMPTS[2])

    const history = page.getByRole('tree', { name: 'Sessions', exact: true })
    await history.locator(`[data-row-key="session:${sessionIds[0]}"]`).click()
    await ide.waitFor({ state: 'detached', timeout: 10_000 })
    const ungrouped = history.getByRole('treeitem').filter({ has: page.getByText('Ungrouped', { exact: true }) })
    await ungrouped.waitFor({ timeout: 10_000 })
    if (await ungrouped.getAttribute('aria-expanded') !== 'true') await ungrouped.click()
    const historyTitles: string[] = []
    for (const [index, prompt] of PROMPTS.entries()) {
      const row = history.locator(`[data-row-key="session:${sessionIds[index]}"]`)
      const title = row.getByText(prompt, { exact: true })
      await title.waitFor({ timeout: 15_000 })
      historyTitles.push(await title.innerText())
    }
    expect({ tabs: tabTitles, history: historyTitles }).toMatchInlineSnapshot(`
      {
        "history": [
          "Inspect login redirects",
          "Review query performance",
          "Plan browser coverage",
        ],
        "tabs": [
          "Inspect login redirects",
          "Review query performance",
          "Plan browser coverage",
        ],
      }
    `)
  }, 90_000)
})
