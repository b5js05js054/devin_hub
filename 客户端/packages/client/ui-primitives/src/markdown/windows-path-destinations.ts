/** Keep backslash separators in Markdown destinations written as Windows paths. */
import type { Definition, Image, Link } from 'mdast'
import type { CompileContext, Extension, Token } from 'mdast-util-from-markdown'
import { decodeString } from 'micromark-util-decode-string'

/**
 * A raw destination is a Windows path when it has a backslash and no URL
 * scheme, and either has no slash or has a backslash before a letter or digit.
 */
function isWindowsPath(raw: string): boolean {
  return raw.includes('\\') && !/^[a-z][a-z\d+.-]+:/iu.test(raw)
    && (!raw.includes('/') || /\\[\p{L}\p{N}]/u.test(raw))
}

function exitDestination(this: CompileContext, token: Token): void {
  const parsed = this.resume()
  const raw = this.sliceSerialize(token)
  const node = this.stack.at(-1) as Link | Image | Definition
  node.url = isWindowsPath(raw) ? decodeString(raw.replaceAll('\\', '\\\\')) : parsed
}

/**
 * Keep Windows path separators literal while parsing Markdown link destinations.
 * @returns The mdast extension.
 */
export function windowsPathDestinations(): Extension {
  return { exit: { resourceDestinationString: exitDestination, definitionDestinationString: exitDestination } }
}
