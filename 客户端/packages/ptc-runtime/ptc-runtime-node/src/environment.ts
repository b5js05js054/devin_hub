/** Startup variables required by native executables before model evaluation. */

/**
 * Names retained in the OS environment: native executable search, sandbox temporary paths, and the
 * Windows system, profile and account variables libuv restores into every child environment block.
 * A nested process missing `SYSTEMDRIVE` resolves shell folders to a literal `%SystemDrive%` path
 * under its working directory.
 */
export const STARTUP_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP',
  'SYSTEMDRIVE', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'LOGONSERVER',
])

/** Spellings Node's Windows `os.tmpdir()` reads from `process.env`, in lookup order. */
const TEMPORARY_DIRECTORY_NAMES = ['TEMP', 'TMP', 'SystemRoot', 'windir'] as const

/**
 * Clear inherited credentials while preserving native child-process startup paths.
 * The names Node's Windows `os.tmpdir()` reads stay readable as non-enumerable entries, so that
 * call returns the native temporary directory while enumeration, spreading, and default
 * child-process inheritance observe an empty program environment.
 * @param state - Child process environment, replaced with an empty program-visible object.
 */
export function clearProgramEnvironment(state: { env: NodeJS.ProcessEnv }): void {
  const retained = new Map<string, string>()
  for (const key of Object.keys(state.env)) {
    const name = key.toUpperCase()
    const value = state.env[key]
    if (!STARTUP_ENVIRONMENT_NAMES.has(name)) Reflect.deleteProperty(state.env, key)
    else if (value !== undefined) retained.set(name, value)
  }
  const env = Object.create(null) as NodeJS.ProcessEnv
  for (const name of TEMPORARY_DIRECTORY_NAMES) {
    const value = retained.get(name.toUpperCase())
    if (value !== undefined) Object.defineProperty(env, name, { value, writable: true, configurable: true, enumerable: false })
  }
  state.env = env
}
