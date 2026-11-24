// @vitest-environment jsdom

import { Context } from '@deepseek-ai/cordis'
import { ClientSessions } from '@deepseek-ai/dsh-api-session-controller/src/client/sessions/service.ts'
import type { SessionRemote } from '@deepseek-ai/dsh-api-session-controller/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LayoutController, type MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

const IDE = 'ide' as MainPanelId
const OTHER = 'other' as MainPanelId
const SESSION = 'ide-refresh-session' as SessionId
const summary = { sessionId: SESSION, agentAvailable: true, running: false, blank: false, updatedAt: 100, cwd: 'C:/repo' }

async function bench(initial: MainPanelId | null = null) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const list = vi.fn<SessionRemote['list']>().mockResolvedValue({ ok: true, value: { items: [summary] } })
  new TestRemote(ctx, { session: { list }, workspaceFiles: {} })
  // No Session is opened: only the list RPC is exercised by the real object layer.
  const sessions = new ClientSessions(ctx, ctx.remote)
  const panels = createLayoutStore().create()
  panels.actions.selectPanel(initial)
  const layout = new LayoutController(panels.actions, () => true, {
    getSnapshot: () => panels.getSnapshot().panelInfo,
    subscribe: listener => panels.subscribe(listener),
  })
  ctx.provide('layout', layout)
  ctx.provide('theme', {} as never)
  ctx.provide('workspaces', {} as never)
  ctx.provide('sidebarRight', { registerFallbackOpener: () => () => {} } as never)
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  return { ctx, sessions, layout, panels, list, fiber }
}

describe('ui-editor Session list refresh', () => {
  it.each([null, OTHER])('refreshes the real Session catalog when leaving IDE for %s', async (target) => {
    const b = await bench(IDE)
    b.list.mockResolvedValue({ ok: true, value: { items: [{
      ...summary, projections: { kind: 'cached', asOfSeq: 1, values: { title: 'IDE generated title' } },
    }] } })
    expect(b.sessions.list.getSnapshot().ids).toEqual([])
    expect(b.list).not.toHaveBeenCalled()

    b.layout.selectPanel(target)

    await vi.waitFor(() => { expect(b.sessions.list.getSnapshot().ids).toEqual([SESSION]) })
    expect(b.sessions.list.getSnapshot().byId[SESSION]).toMatchObject({
      cwd: 'C:/repo', title: 'IDE generated title', displayTitle: 'IDE generated title',
    })
    expect(b.list).toHaveBeenCalledOnce()
    b.layout.selectPanel(target)
    b.panels.actions.setSidebar(350)
    expect(b.list).toHaveBeenCalledOnce()
  })

  it.each([null, OTHER])('does not refresh from initial panel %s, entering IDE, or resizing it', async (initial) => {
    const b = await bench(initial)
    b.layout.selectPanel(OTHER)
    b.layout.selectPanel(null)
    b.layout.selectPanel(IDE)
    b.panels.actions.setSidebar(350)
    b.panels.actions.setViewportWidth(1400)
    b.panels.actions.setRightbar(500)
    b.layout.selectPanel(IDE)

    expect(b.list).not.toHaveBeenCalled()
    expect(b.sessions.list.getSnapshot().ids).toEqual([])
  })

  it('releases its observer on disposal and installs one fresh observer on reload', async () => {
    const b = await bench(IDE)
    b.layout.selectPanel(null)
    await vi.waitFor(() => { expect(b.sessions.list.getSnapshot().ids).toEqual([SESSION]) })
    b.layout.selectPanel(IDE)

    await b.fiber.dispose()
    b.list.mockResolvedValue({ ok: true, value: { items: [] } })
    b.layout.selectPanel(null)
    expect(b.list).toHaveBeenCalledOnce()
    expect(b.sessions.list.getSnapshot().ids).toEqual([SESSION])

    await b.ctx.plugin({ inject, apply }).await()
    expect(b.list).toHaveBeenCalledOnce()
    b.layout.selectPanel(IDE)
    b.layout.selectPanel(null)
    await vi.waitFor(() => { expect(b.sessions.list.getSnapshot().ids).toEqual([]) })
    expect(b.list).toHaveBeenCalledTimes(2)
  })

  it('keeps the established catalog after a normal Remote failure and retries on the next IDE exit', async () => {
    const b = await bench(IDE)
    await b.sessions.refresh()
    const refresh = vi.spyOn(b.sessions, 'refresh')
    b.list.mockRejectedValueOnce(new RemoteError('gateway/internal', 'offline', {}))
    b.layout.selectPanel(null)
    await vi.waitFor(() => { expect(refresh).toHaveBeenCalledOnce() })
    const result = refresh.mock.results[0]
    if (result?.type !== 'return') throw new Error('IDE exit did not return a Session refresh Promise')
    await result.value
    expect(b.sessions.list.getSnapshot().ids).toEqual([SESSION])

    b.list.mockResolvedValue({ ok: true, value: { items: [] } })
    b.layout.selectPanel(IDE)
    b.layout.selectPanel(null)
    await vi.waitFor(() => { expect(b.sessions.list.getSnapshot().ids).toEqual([]) })
    expect(b.list).toHaveBeenCalledTimes(3)
  })

  it('contains an unexpected refresh rejection and allows the next IDE exit to refresh', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => { report.mockRestore() })
    const b = await bench(IDE)
    const failure = new Error('unexpected list failure')
    b.list.mockRejectedValueOnce(failure)

    b.layout.selectPanel(null)

    await vi.waitFor(() => { expect(report).toHaveBeenCalledWith(expect.any(String), failure) })
    expect(b.sessions.list.getSnapshot().ids).toEqual([])
    b.layout.selectPanel(IDE)
    b.layout.selectPanel(null)
    await vi.waitFor(() => { expect(b.sessions.list.getSnapshot().ids).toEqual([SESSION]) })
    expect(b.list).toHaveBeenCalledTimes(2)
  })
})
