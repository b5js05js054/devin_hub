/** Load xterm only after a terminal body is mounted. */
import { lazy, Suspense, type ComponentProps, type ReactNode } from 'react'
import type { TerminalBodyProps } from './terminal.tsx'

const LoadedTerminalBody = lazy(async () => ({ default: (await import('./terminal.tsx')).TerminalBody }))

/**
 * Suspend while the package-local terminal chunk arrives.
 * @param props - Terminal body props supplied by the sidebar slot.
 * @returns the deferred terminal renderer.
 */
export function LazyTerminalBody(props: TerminalBodyProps): ReactNode {
  return <Suspense fallback={null}><LoadedTerminalBody {...props} /></Suspense>
}

const LoadedEmbeddedTerminal = lazy(async () => ({ default: (await import('./terminal.tsx')).EmbeddedTerminal }))

/**
 * Suspend while the terminal chunk arrives for a non-sidebar surface.
 * @param props - Factory props supplied by the caller's slot.
 * @returns the deferred terminal renderer.
 */
export function LazyEmbeddedTerminal(props: ComponentProps<typeof LoadedEmbeddedTerminal>): ReactNode {
  return <Suspense fallback={null}><LoadedEmbeddedTerminal {...props} /></Suspense>
}
