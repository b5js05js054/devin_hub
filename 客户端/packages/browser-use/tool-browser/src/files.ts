/**
 * The files a session's browser saves. Screenshots without a path and
 * downloads started by a click are named by the browser, so the tool finds
 * them by watching the session's output directory.
 * @module @deepseek-ai/dsh-tool-browser/files
 */

import { readdir } from 'node:fs/promises'

/** Names Chrome gives a download that is still in progress. */
const PARTIAL_DOWNLOAD = /\.(?:crdownload|tmp)$/iu

/**
 * List the finished files directly inside a directory.
 * @param directory - an existing directory.
 * @returns the file names in sorted order, without in-progress downloads.
 */
export async function listSavedFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return entries
    .filter(entry => entry.isFile() && !PARTIAL_DOWNLOAD.test(entry.name))
    .map(entry => entry.name)
    .sort()
}

/**
 * Report the files that appeared in a directory since it was last checked,
 * and remember them.
 * @param directory - the session's output directory.
 * @param known - names already reported or present before the session; updated in place.
 * @returns the names not seen before, in sorted order.
 */
export async function claimNewFiles(directory: string, known: Set<string>): Promise<string[]> {
  const fresh = (await listSavedFiles(directory)).filter(name => !known.has(name))
  for (const name of fresh) known.add(name)
  return fresh
}
