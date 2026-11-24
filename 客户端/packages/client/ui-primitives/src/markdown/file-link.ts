/** Local Markdown destinations accepted by the file-preview callback. */

/**
 * Decode a file destination with a fragment, line range, or line/column suffix.
 * Explicit relative, rooted, and Windows drive paths take precedence over URLs.
 * Invalid locations open the path without selecting a line; columns are consumed.
 * Literal `?`, `#`, and numeric-colon suffixes in filenames must be percent-encoded.
 * @param value - Parsed Markdown link destination.
 * @returns A local path and optional first line, or undefined for URLs, network
 * paths, queries, malformed escapes, or invalid fragments.
 */
export function parseFileLink(value: string): { path: string; line?: number } | undefined {
  const hash = value.indexOf('#')
  const destination = hash < 0 ? value : value.slice(0, hash)
  if (destination.includes('?')) return undefined
  let decodedDestination: string
  try {
    decodedDestination = decodeURIComponent(destination)
  } catch (_error) {
    // Malformed percent escapes cannot identify a file unambiguously.
    return undefined
  }
  const explicitFilePath = /^(?:[\\/]|\.{1,2}[\\/]|[a-z]:[\\/])/i.test(decodedDestination)
  if (!explicitFilePath && URL.canParse(decodedDestination)) return undefined
  const suffix = hash < 0 ? /:(\d+)(?::\d+|-(\d+))?$/.exec(destination) : null
  const encodedPath = suffix === null ? destination : destination.slice(0, -suffix[0].length)
  let path: string
  try {
    path = decodeURIComponent(encodedPath)
  } catch (_error) {
    // Malformed percent escapes cannot identify a file unambiguously.
    return undefined
  }
  if (path.length === 0 || /[\u0000-\u001f\u007f]/.test(path) || /^[\\/]{2}/.test(path)) return undefined
  const match = suffix ?? (hash < 0 ? null : /^L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(value.slice(hash + 1)))
  if (match === null) return hash < 0 ? { path } : undefined
  const line = Number(match[1])
  const end = match[2] === undefined ? line : Number(match[2])
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(end) || line < 1 || end < line) {
    return suffix === null ? undefined : { path }
  }
  return { path, line }
}
