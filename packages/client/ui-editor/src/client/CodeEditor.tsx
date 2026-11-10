import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type * as Monaco from 'monaco-editor'
import type { Hunk } from './hunks.ts'
import css from './CodeEditor.module.css'

/** Height of the review strip pinned above each changed block. */
const ZONE_HEIGHT = 30

/**
 * Lift the view-zone layer above Monaco's line layer, which otherwise swallows the
 * strip's pointer events; the layer itself stays transparent to input.
 * @param editor - the modified-side editor.
 */
function layerZones(editor: Monaco.editor.ICodeEditor): void {
  const layer = editor.getDomNode()?.querySelector('.view-zones')
  if (!(layer instanceof HTMLElement)) return
  layer.style.zIndex = '5'
  layer.style.pointerEvents = 'none'
}

/** Props of the Monaco-backed text surface. */
export interface CodeEditorProps {
  readonly path: string
  /** Text the user last accepted; the read-only side of the inline diff. */
  readonly baseline: string
  /** Disk text that in-flight Agent changes produced; the editable side. */
  readonly text: string
  /** Pending Agent blocks to review, in disk line numbers. */
  readonly hunks: readonly Hunk[]
  readonly dark: boolean
  /** Location requested by a workspace content search. */
  readonly reveal: { readonly path: string; readonly line: number; readonly column: number; readonly revision: number } | undefined
  readonly onChange: (text: string) => void
  readonly onSave: () => void
  /**
   * Render the review controls of one changed block.
   * @param hunk - the block the strip belongs to.
   * @param index - block position in the file.
   * @returns the strip contents.
   */
  readonly renderHunkActions: (hunk: Hunk, index: number) => ReactNode
}

/** One file's models and the view state saved while another file is shown. */
interface Entry {
  reveal: number | undefined
  readonly original: Monaco.editor.ITextModel
  readonly modified: Monaco.editor.ITextModel
  readonly listener: Monaco.IDisposable
  view: Monaco.editor.ICodeEditorViewState | null
}

/** The mounted inline diff: its models are cached per file so undo history and view state survive tab switches. */
interface Surface {
  readonly diff: Monaco.editor.IStandaloneDiffEditor
  readonly entries: Map<string, Entry>
  shown: string | undefined
}

/** Open files whose models stay alive; the least recently shown is disposed beyond this. */
const MAX_MODELS = 20

type Api = typeof Monaco
let apiPromise: Promise<Api> | undefined

function loadMonaco(): Promise<Api> {
  apiPromise ??= import('./monaco.ts').then(module => module.monaco)
  return apiPromise
}

function languageOf(api: Api, path: string): string {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  return api.languages.getLanguages().find(language => language.extensions?.includes(ext))?.id ?? 'plaintext'
}

/**
 * Make `model` hold `text` by replacing only the differing middle, so the undo stack and cursor survive.
 * @param model - the model to update.
 * @param text - the wanted content.
 */
function replaceText(model: Monaco.editor.ITextModel, text: string): void {
  const old = model.getValue()
  if (old === text) return
  let start = 0
  const max = Math.min(old.length, text.length)
  while (start < max && old.charCodeAt(start) === text.charCodeAt(start)) start++
  let end = 0
  while (end < max - start && old.charCodeAt(old.length - 1 - end) === text.charCodeAt(text.length - 1 - end)) end++
  const from = model.getPositionAt(start)
  const to = model.getPositionAt(old.length - end)
  model.pushEditOperations([], [{ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: text.slice(start, text.length - end) }], () => null)
}

/**
 * Code surface rendering the accepted text against the pending Agent text as an
 * inline diff, with one review strip above each changed block.
 * @param props - both texts, blocks to review, theme, and edit/save callbacks.
 * @returns the editor host element.
 */
export function CodeEditor(props: CodeEditorProps): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const live = useRef(props)
  live.current = props
  const surface = useRef<Surface | undefined>(undefined)
  const apiRef = useRef<Api | undefined>(undefined)
  const marks = useRef<Monaco.editor.IEditorDecorationsCollection | undefined>(undefined)
  const zones = useRef<string[]>([])
  const applying = useRef(false)
  const [strips, setStrips] = useState<Array<{ node: HTMLDivElement; hunk: Hunk }>>([])

  function entryFor(api: Api, mounted: Surface, path: string): Entry {
    const known = mounted.entries.get(path)
    if (known !== undefined) {
      mounted.entries.delete(path)
      mounted.entries.set(path, known)
      return known
    }
    const language = languageOf(api, path)
    const original = api.editor.createModel(live.current.baseline, language)
    const modified = api.editor.createModel(live.current.text, language)
    const listener = modified.onDidChangeContent(() => {
      if (!applying.current && mounted.shown === path) live.current.onChange(modified.getValue())
    })
    const entry: Entry = { reveal: undefined, original, modified, listener, view: null }
    mounted.entries.set(path, entry)
    for (const [key, old] of mounted.entries) {
      if (mounted.entries.size <= MAX_MODELS) break
      if (key === path || key === mounted.shown) continue
      old.listener.dispose()
      old.original.dispose()
      old.modified.dispose()
      mounted.entries.delete(key)
    }
    return entry
  }

  function sync(): void {
    const api = apiRef.current
    const mounted = surface.current
    if (api === undefined || mounted === undefined) return
    const { path, text, baseline, hunks } = live.current
    const editor = mounted.diff.getModifiedEditor()
    applying.current = true
    if (mounted.shown !== path) {
      if (mounted.shown !== undefined) {
        const previous = mounted.entries.get(mounted.shown)
        if (previous !== undefined) previous.view = editor.saveViewState()
      }
      const entry = entryFor(api, mounted, path)
      mounted.diff.setModel({ original: entry.original, modified: entry.modified })
      mounted.shown = path
      if (entry.view !== null) editor.restoreViewState(entry.view)
    }
    const shown = mounted.entries.get(path)!
    replaceText(shown.original, baseline)
    replaceText(shown.modified, text)
    applying.current = false
    marks.current?.clear()
    marks.current = editor.createDecorationsCollection(hunks.map((hunk) => {
      const from = Math.max(hunk.modifiedStart, 1)
      const to = Math.max(hunk.modifiedEnd, from)
      return {
        range: new api.Range(from, 1, to, 1),
        options: { isWholeLine: true, linesDecorationsClassName: hunk.modifiedEnd === 0 ? css.barRemoved! : css.barAdded! },
      }
    }))
    const hosts = hunks.map((hunk) => {
      const node = document.createElement('div')
      node.className = css.strip!
      return { node, hunk }
    })
    editor.changeViewZones((accessor) => {
      for (const id of zones.current) accessor.removeZone(id)
      zones.current = hosts.map(({ node, hunk }) => accessor.addZone({
        afterLineNumber: hunk.modifiedEnd === 0 ? hunk.modifiedStart : Math.max(hunk.modifiedStart - 1, 0),
        domNode: node,
        heightInPx: ZONE_HEIGHT,
      }))
    })
    layerZones(editor)
    setStrips(hosts)
    const reveal = live.current.reveal
    if (reveal?.path === path && shown.reveal !== reveal.revision) {
      shown.reveal = reveal.revision
      editor.setPosition({ lineNumber: reveal.line, column: reveal.column })
      editor.revealPositionInCenter({ lineNumber: reveal.line, column: reveal.column })
      editor.focus()
    }
  }

  useEffect(() => {
    let disposed = false
    let cleanup = (): void => {}
    void loadMonaco().then((api) => {
      if (disposed || host.current === null) return
      apiRef.current = api
      const diff = api.editor.createDiffEditor(host.current, {
        renderSideBySide: false,
        compactMode: true,
        diffAlgorithm: 'legacy',
        originalEditable: false,
        readOnly: false,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'off',
        renderOverviewRuler: false,
        renderIndicators: false,
        glyphMargin: false,
        lineDecorationsWidth: 0,
        folding: false,
        theme: live.current.dark ? 'vs-dark' : 'vs',
        fontSize: 13,
      })
      const mounted: Surface = { diff, entries: new Map(), shown: undefined }
      surface.current = mounted
      diff.getModifiedEditor().addCommand(api.KeyMod.CtrlCmd | api.KeyCode.KeyS, () => { live.current.onSave() })
      cleanup = () => {
        diff.setModel(null)
        diff.dispose()
        for (const entry of mounted.entries.values()) {
          entry.listener.dispose()
          entry.original.dispose()
          entry.modified.dispose()
        }
        mounted.entries.clear()
      }
      sync()
    })
    return () => { disposed = true; cleanup(); surface.current = undefined; marks.current = undefined; zones.current = [] }
  }, [])

  useEffect(sync, [props.path, props.text, props.baseline, props.hunks, props.reveal])
  useEffect(() => { apiRef.current?.editor.setTheme(props.dark ? 'vs-dark' : 'vs') }, [props.dark])

  return (
    <>
      <div ref={host} className={css.host} data-code-editor={props.path} />
      {strips.map(({ node, hunk }, index) => createPortal(props.renderHunkActions(hunk, index), node, index))}
    </>
  )
}
