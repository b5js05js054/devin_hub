/** Open the repository package manifest from a Chinese directory through the real IDE and Host. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

let scaffold: WebScaffold
let browser: Browser
let page: Page

beforeAll(async () => {
  scaffold = await launchWebScaffold()
  const directory = join(scaffold.workspaceCwd, 'workspace', '客户端')
  await mkdir(directory, { recursive: true })
  const packageJson = await readFile(new URL('../../../package.json', import.meta.url))
  await writeFile(join(directory, 'package.json'), packageJson)
  browser = await chromium.launch()
  page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
}, 120_000)

afterAll(async () => {
  try { await browser?.close() } finally { await scaffold?.close() }
})

it('opens UTF-8 JSON under a Chinese directory from the file tree', async () => {
  onTestFailed(() => saveFailureShot(page, 'web-e2e-ide-text-file-open'))
  await page.getByRole('button', { name: 'IDE', exact: true }).click()
  const ide = page.locator('[data-ide]')
  const tree = ide.getByRole('tree', { name: 'Files', exact: true })
  await tree.getByRole('treeitem', { name: '客户端', exact: true }).click()
  await tree.getByRole('treeitem', { name: 'package.json', exact: true }).click()
  const editor = ide.locator('[data-ide-column="editor"]')
  await expect.poll(() => editor.innerText(), { timeout: 30_000 }).toContain('@deepseek-ai/dsh-root')
  expect(await editor.getByRole('alert').count()).toBe(0)
}, 30_000)
