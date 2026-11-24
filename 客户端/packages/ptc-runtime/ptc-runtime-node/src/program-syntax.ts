/** Host-side report for a program rejected while erasing its TypeScript types. */

/**
 * Render a type-erasure failure for the program author. The parser message alone reads like an
 * exception thrown mid-run, so the text names the failure class and states that no statement ran.
 * @param error - the value thrown by `stripTypeScriptTypes`.
 * @returns the failure message for an `exception` result.
 */
export function programSyntaxMessage(error: unknown): string {
  return `SyntaxError: ${error instanceof Error ? error.message : String(error)} (the program was not executed)`
}
