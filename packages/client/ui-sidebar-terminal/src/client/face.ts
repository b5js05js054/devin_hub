/** Injected terminal commands and keyed observable state. */
import type { WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { TerminalView, TerminalViewState } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

/** The terminal's React-free model is resolved by sidebar occurrence. */
export interface TerminalInjected {
  /** @param key - sidebar occurrence key. @returns its terminal commands. */
  readonly view: (key: string) => TerminalView
  readonly keyedHooks: { readonly terminal: (key: string) => HostObservable<TerminalViewState> }
}


/** The terminal screen follows the resolved application theme through a framework hook. */
export interface TerminalBodyInjected extends TerminalInjected {
  readonly hooks: { readonly theme: HostObservable<ThemeSnapshot> }
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** An existing Host terminal selected from the Session terminal list. */
    terminal: { terminalId: WebTerminalId } | { shellPath: string }
  }
}

/** Props injected into the embedded terminal Factory for one Session; terminals are addressed by a caller-chosen key. */
export interface EmbeddedTerminalInjected {
  /** @param key - caller-owned terminal key. @returns its terminal model. */
  readonly view: (key: string) => TerminalView
  /** Keep one terminal's Host attachment alive while mounted. @returns the release. */
  readonly hold: (key: string) => () => void
  /** End one terminal's process and forget it. */
  readonly close: (key: string) => void
  readonly keyedHooks: { readonly terminal: (key: string) => HostObservable<TerminalViewState> }
  readonly hooks: { readonly theme: HostObservable<ThemeSnapshot> }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** A Session terminal rendered outside the sidebar, retained for as long as it is mounted. */
    'terminal.embedded': {
      scope: 'session'
      props: { terminalKey: string; active: boolean; closing: boolean; onClosed: () => void }
      inject: EmbeddedTerminalInjected
      locale: 'sidebarTerminal'
    }
  }
}
