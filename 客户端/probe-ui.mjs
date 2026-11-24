
import { chromium } from 'file:///E:/devin_hub/客户端/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs'
const url = process.argv[2]
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, locale: 'zh-CN' })
page.on('console', m => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 300)) })
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(3000)
await page.screenshot({ path: 'E:/devin_hub/shot-1-home.png' })
const texts = await page.locator('[role], button, [aria-label]').evaluateAll(els =>
  els.map(e => ({ tag: e.tagName, role: e.getAttribute('role'), label: e.getAttribute('aria-label') || e.textContent?.trim().slice(0,30) })).filter(x => x.label)
)
console.log(JSON.stringify(texts.slice(0, 90), null, 1))
await browser.close()
