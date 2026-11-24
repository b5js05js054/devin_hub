/** The completed root turn can review file-tool edits from both agents when Git cannot snapshot the worktree. */
import { execFileSync, execSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { LoggerLevel } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-workspace-changes'
import { fixtureUserPrompts, launchWebScaffold, readPersistedEvents, selectedSessionFixture, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, writeComposerDraft } from './support.ts'

it.skipIf(webSnapshotMode() === 'record')('opens the root write and delegated edit from the completed turn after a Git snapshot failure', async () => {
  const fixture = (name: string) => selectedSessionFixture(join(REPO_ROOT, 'snapshots/session', name, 'session.v4.jsonl'))
  const [rootFixture, childFixture] = await Promise.all([fixture('fs-write'), fixture('fs-edit')])
  const rootLog = await readFile(rootFixture, 'utf8')
  const childPrompt = fixtureUserPrompts(await readFile(childFixture, 'utf8'))[0]!
  const call = { type: 'tool-call' as const, id: ToolCallId('delegate-edit'), name: 'subagent',
    arguments: JSON.stringify({ description: 'Edit the configuration', prompt: childPrompt }) }
  const script = deriveReplayScript(parseSessionLog(rootLog))
  script.unshift({ kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments },
    { type: 'block-end', index: 0, block: call },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ] })
  const replayDir = await mkdtemp(join(tmpdir(), 'dsh-changes-fallback-replay-'))
  onTestFinished(() => rm(replayDir, { recursive: true, force: true }))
  const replayOverride = join(replayDir, 'replay.override.json')
  await writeFile(replayOverride, JSON.stringify(script))
  const scaffold = await launchWebScaffold({
    replayFixture: rootFixture, replayOverride, replayChildFixtures: [childFixture], compareReplaySession: false, developerTools: true,
  })
  onTestFinished(() => scaffold.close())
  const { ctx } = scaffold
  const warnings: string[] = []
  ctx.logger.exporter({ levels: { default: LoggerLevel.WARN }, export: (message) => {
    if (message.type === 'warn') warnings.push(String(message.args[0]))
  } })
  const cwd = join(scaffold.workspaceCwd, 'workspace')
  await mkdir(cwd)
  execFileSync('git', ['init', '-q'], { cwd, stdio: 'ignore' })
  await writeFile(join(cwd, 'config.txt'), 'mode=DEBUG\nlevel=info\n')
  // Discovery still succeeds. Git rejects this index when the recorder stages its private snapshot.
  await writeFile(join(cwd, '.git', 'index'), 'invalid index')

  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const parent = ctx.agents.list().find(agent => agent.session.header.cwd === cwd && agent.session.header.parentSession === undefined)
  if (parent === undefined) throw new Error('the selected workspace has no live root Agent')

  // Keep the root turn open until the real subagent tool's child and the independent shell have finished.
  let childId: SessionId | undefined
  ctx.on('subagent/end', (info) => { childId = info.id })
  const resume = Promise.withResolvers<undefined>()
  const off = ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent === parent && exec.name === 'write') await resume.promise
    return next()
  })
  try {
    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, `Delegate the config edit. ${fixtureUserPrompts(rootLog)[0]!}`)
    await input.press('Enter')
    await expect.poll(() => childId, { timeout: 30_000 }).toBeDefined()
    const childEvents = await readPersistedEvents(scaffold, childId!)
    expect(childEvents.filter(event => event.type === 'tool/result').map(event => event.data.message.isError)).toEqual([false, false])
    expect(childEvents.filter(event => event.type === 'workspace/changes')).toEqual([])
    expect(await readFile(join(cwd, 'config.txt'), 'utf8')).toBe('mode=RELEASE\nlevel=info\n')
    execSync('echo shell change>shell-only.txt', { cwd, stdio: 'ignore' })
    expect((await readFile(join(cwd, 'shell-only.txt'), 'utf8')).trim()).toBe('shell change')
  } finally {
    resume.resolve(undefined)
    off()
  }
  await parent.whenIdle()
  expect(await readFile(join(cwd, 'notes.txt'), 'utf8')).toBe('hello world')
  const events = parent.session.snapshotEvents()
  expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['subagent', 'write'])
  expect(events.filter(event => event.type === 'tool/result').map(event => event.data.message.isError)).toEqual([false, false])
  expect(events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
  expect(warnings.join('\n')).toMatch(/workspace-changes:.*git add/i)
  const announced = events.filter(event => event.type === 'workspace/changes')
  expect(announced, 'the root completion must announce the fallback summary').toHaveLength(1)
  const summary = ctx.workspaceChanges.summary(parent.id, announced[0]!.seq)
  expect(summary?.snapshot).toBeUndefined()
  expect(summary?.files).toEqual([
    { path: 'config.txt', display: 'config.txt', added: 1, deleted: 1 },
    { path: 'notes.txt', display: 'notes.txt', added: 1, deleted: 0 },
  ])

  const card = page.locator('[data-turn-tail="1"] [data-changed-files]')
  await card.getByText('Edited 2 files', { exact: true }).waitFor()
  expect(await card.getByRole('listitem').count()).toBe(2)
  const review = page.locator('[data-rightbar-col] [data-changes-review]')
  await card.getByRole('button', { name: 'View changes to notes.txt', exact: true }).click()
  await review.locator('[data-review-file="notes.txt"]').waitFor()
  await review.locator('[data-diff-line="add"]').getByText('hello world', { exact: true }).waitFor()
  await card.getByRole('button', { name: 'View changes to config.txt', exact: true }).click()
  await review.locator('[data-review-file="config.txt"]').waitFor()
  await review.locator('[data-diff-side="left"]').getByText('mode=DEBUG', { exact: true }).waitFor()
  await review.locator('[data-diff-side="right"]').getByText('mode=RELEASE', { exact: true }).waitFor()
})
