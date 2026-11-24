/** IDE creation menus use real pointer input and persist entries in an isolated workspace. */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

describe.skipIf(webSnapshotMode() === 'record')('web e2e: IDE file creation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  const pageErrors: string[] = []

  beforeAll(async () => {
    browser = await chromium.launch()
    scaffold = await launchWebScaffold()
    page = await newEnglishPage(browser)
    page.on('pageerror', error => { pageErrors.push(error.stack ?? String(error)) })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('creates a file and folder from blank-space menus without replacing entry actions', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ide-file-create'))
    const workspace = join(scaffold.workspaceCwd, 'workspace')
    expect(await readdir(workspace)).toEqual([])
    await page.getByRole('button', { name: 'IDE', exact: true }).click()
    const ide = page.locator('[data-ide]')
    await ide.waitFor({ timeout: 15_000 })
    const files = ide.locator('[data-ide-column="files"]')
    const tree = files.getByRole('tree', { name: 'Files', exact: true })
    await tree.waitFor()
    await tree.getByText('Loading…', { exact: true }).waitFor({ state: 'hidden' })
    expect(await tree.getByRole('treeitem').count()).toBe(0)
    const menu = page.getByRole('menu').filter({
      has: page.getByRole('menuitem', { name: 'New File', exact: true }),
    })

    async function expectCreationMenu(): Promise<void> {
      await menu.waitFor()
      expect(await menu.getByRole('menuitem').allTextContents()).toEqual(['New File', 'New Folder'])
      expect(await menu.getByRole('separator').count()).toBe(0)
    }

    async function clickBlank(button: 'left' | 'right'): Promise<void> {
      const box = await tree.boundingBox()
      if (box === null) throw new Error('IDE file tree has no pointer target')
      const position = { x: box.width - 12, y: box.height - 12 }
      // Hit-test only: Playwright delivers the actual pointer event below.
      expect(await tree.evaluate((element, point) => {
        const rect = element.getBoundingClientRect()
        return document.elementFromPoint(rect.left + point.x, rect.top + point.y) === element
      }, position)).toBe(true)
      await tree.click({ button, position })
      await expectCreationMenu()
    }

    async function expectMenuInsideViewport(target: Locator): Promise<void> {
      const viewport = page.viewportSize()
      if (viewport === null) throw new Error('IDE browser test needs a fixed viewport')
      await expect.poll(async () => {
        const box = await target.boundingBox()
        return box !== null && box.x >= 0 && box.y >= 0
          && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height
      }).toBe(true)
    }

    async function createEntry(kind: 'New File' | 'New Folder', name: string): Promise<void> {
      await menu.getByRole('menuitem', { name: kind, exact: true }).click()
      await menu.waitFor({ state: 'hidden' })
      const input = files.getByRole('textbox', { name: 'Name', exact: true })
      await input.fill(name)
      await files.getByRole('button', { name: 'OK', exact: true }).click()
      await input.waitFor({ state: 'hidden' })
    }

    // The first creation starts with no file rows at all.
    await clickBlank('left')
    await expectMenuInsideViewport(menu)
    await createEntry('New File', 'created-from-blank.txt')
    await expect.poll(() => readdir(workspace), { timeout: 10_000 }).toContain('created-from-blank.txt')
    expect((await stat(join(workspace, 'created-from-blank.txt'))).isFile()).toBe(true)
    expect(await readFile(join(workspace, 'created-from-blank.txt'), 'utf8')).toBe('')
    const fileRow = tree.getByRole('treeitem', { name: 'created-from-blank.txt', exact: true })
    await fileRow.waitFor({ timeout: 10_000 })

    await fileRow.click()
    expect(await menu.count()).toBe(0)
    await ide.locator('[data-ide-tab]').filter({ hasText: 'created-from-blank.txt' }).waitFor()
    await fileRow.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor()
    expect(await menu.getByRole('menuitem').count()).toBeGreaterThan(2)
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })

    await clickBlank('right')
    await expectMenuInsideViewport(menu)
    await createEntry('New Folder', 'folder-from-blank')
    await expect.poll(() => readdir(workspace), { timeout: 10_000 }).toContain('folder-from-blank')
    expect((await stat(join(workspace, 'folder-from-blank'))).isDirectory()).toBe(true)
    expect(await readdir(join(workspace, 'folder-from-blank'))).toEqual([])
    await tree.getByRole('treeitem', { name: 'folder-from-blank', exact: true }).waitFor({ timeout: 10_000 })

    await clickBlank('left')
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
    await clickBlank('right')
    await ide.locator('[data-ide-column="editor"]').click({ position: { x: 20, y: 80 } })
    await menu.waitFor({ state: 'hidden' })

    await files.getByRole('button', { name: 'New File', exact: true }).click()
    await expectCreationMenu()
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })

    await clickBlank('left')
    await expectMenuInsideViewport(menu)
    await saveFailureShot(page, 'web-e2e-ide-file-create-menu')
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
    expect((await readdir(workspace)).sort()).toEqual(['created-from-blank.txt', 'folder-from-blank'])
    expect(pageErrors).toEqual([])
  }, 60_000)
})
