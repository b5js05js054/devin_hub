/**
 * Structured failures of the browser tool.
 * @module @deepseek-ai/dsh-tool-browser/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable failure classes of the browser tool; route on these, never on message text. */
export type BrowserToolErrorCode =
  | 'BROWSER_INVALID_COMMAND'
  | 'BROWSER_COMMAND_DENIED'
  | 'BROWSER_SANDBOX_DENIED'
  | 'BROWSER_UNAVAILABLE'
  | 'BROWSER_FAILED'
  | 'BROWSER_ABORTED'
  | 'BROWSER_OUTPUT_OVERFLOW'

/** A browser tool call that could not run its commands or read their outcome. */
export class BrowserToolError extends HarnessError {
  declare readonly code: BrowserToolErrorCode

  constructor(message: string, code: BrowserToolErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'BrowserToolError'
  }
}
