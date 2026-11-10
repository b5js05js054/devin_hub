// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { CodeEditor } from '../src/client/CodeEditor.tsx'

const position = vi.fn()
const reveal = vi.fn()
const focus = vi.fn()
const editor = {
  saveViewState: () => null,
  restoreViewState: vi.fn(),
  createDecorationsCollection: () => ({ clear: vi.fn() }),
  changeViewZones: (callback: (accessor: { removeZone: (id: string) => void; addZone: (options: object) => string }) => void) => callback({ removeZone: vi.fn(), addZone: () => 'zone' }),
  addCommand: vi.fn(),
  getDomNode: () => undefined,
  setPosition: position,
  revealPositionInCenter: reveal,
  focus,
}
vi.mock('../src/client/monaco.ts', () => ({
  monaco: {
    editor: {
      createDiffEditor: () => ({ getModifiedEditor: () => editor, setModel: vi.fn(), dispose: vi.fn() }),
      createModel: (text: string) => ({ getValue: () => text, getPositionAt: () => ({ lineNumber: 1, column: 1 }), pushEditOperations: vi.fn(), onDidChangeContent: () => ({ dispose: vi.fn() }), dispose: vi.fn() }),
      setTheme: vi.fn(),
    },
    languages: { getLanguages: () => [] },
    KeyMod: { CtrlCmd: 1 },
    KeyCode: { KeyS: 2 },
    Range: class {},
  },
}))

function mount(reveal: ComponentProps<typeof CodeEditor>['reveal']): ReactNode {
  return <CodeEditor path="a.ts" baseline="one" text="one" hunks={[]} dark={false} reveal={reveal} onChange={vi.fn()} onSave={vi.fn()} renderHunkActions={() => null} />
}

afterEach(cleanup)

describe('CodeEditor search reveal', () => {
  it('reveals a requested position once after Monaco mounts', async () => {
    const view = render(mount({ path: 'a.ts', line: 2, column: 3, revision: 1 }))
    await act(async () => {})
    expect(position).toHaveBeenCalledWith({ lineNumber: 2, column: 3 })
    expect(reveal).toHaveBeenCalledWith({ lineNumber: 2, column: 3 })
    expect(focus).toHaveBeenCalledOnce()
    view.rerender(mount({ path: 'a.ts', line: 2, column: 3, revision: 1 }))
    expect(position).toHaveBeenCalledOnce()
    view.rerender(mount(undefined))
    expect(position).toHaveBeenCalledOnce()
    view.rerender(mount({ path: 'a.ts', line: 4, column: 1, revision: 2 }))
    expect(position).toHaveBeenLastCalledWith({ lineNumber: 4, column: 1 })
    expect(position).toHaveBeenCalledTimes(2)
  })
})
