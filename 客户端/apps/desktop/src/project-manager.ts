/** Desktop profile initialization and native recovery. */

import {
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  DESKTOP_HOST_PACKAGE,
  desktopCorePackageOverrides,
  verifyDesktopCorePackageSet,
} from './core-package-set.ts'
import type { DesktopPaths } from './paths.ts'
import type { DesktopRelease } from './release.ts'
import { readDesktopRuntime, type DesktopRuntimeDescriptor } from './runtime-tree.ts'
import { DESKTOP_EXPERT_BUNDLE } from './expert-bundle.ts'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import {
  initProfile, PROFILE_TEMPLATES, readProfileManifest, removeLinkProjections, sanitizeProfile, type ProfileTemplate,
} from '@deepseek-ai/dsh-app-boot'

const PROJECT_NAME = '@deepseek-ai/dsh-desktop-runtime'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const CORE_BUILD_PACKAGE = '@deepseek-ai/dsh-subprocess-local'
const WEB_PROFILE = PROFILE_TEMPLATES.web as ProfileTemplate
const PREVIOUS_EXPERT_BUNDLE = 'dsh-expert-orchestrator'
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\n'
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 })
}

function workspaceFile(overrides: Readonly<Record<string, string>> = {}): string {
  const entries = Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))
  const overrideSection = entries.length === 0
    ? ''
    : `overrides:\n${entries.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`).join('\n')}\n`
  if (entries.length === 0) return `packages:\n  - .\n\n${WORKSPACE_SETTINGS}`
  const coreBuildSpec = overrides[CORE_BUILD_PACKAGE]
  const coreBuildKey = coreBuildSpec === undefined
    ? CORE_BUILD_PACKAGE
    : `${CORE_BUILD_PACKAGE}@${coreBuildSpec.replace('file:./', 'file:')}`
  return `packages:\n  - .\n\n${overrideSection}${WORKSPACE_SETTINGS}allowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  ${JSON.stringify(coreBuildKey)}: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n  agent-browser: false\n`
}

function migrateProfileSettings(projectDir: string): void {
  const path = join(projectDir, 'pnpm-workspace.yaml')
  if (!existsSync(path)) return
  const legacy = `packages:\n  - .\n\n${WORKSPACE_SETTINGS}strictDepBuilds: true\nallowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  "${CORE_BUILD_PACKAGE}": true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
  if (readFileSync(path, 'utf8').replaceAll('\r\n', '\n') === legacy) {
    writeFileSync(path, workspaceFile())
  }
}

/** Initializes the Desktop profile and disables third-party bundles during recovery. */
export class DesktopProjectManager {
  /**
   * @param paths - Electron-owned package state and reserved desktop profile paths.
   * @param runtime - location of the bundled application runtime.
   */
  constructor(
    readonly paths: DesktopPaths,
    readonly runtime: { readonly dsh: string },
  ) {}

  /**
   * Back up the profile patch and disable third-party bundles without loading application resources.
   * The caller must stop the Host first.
   * @returns Backup path after the locked profile write, or undefined if the patch was absent.
   */
  async disableAllPlugins(): Promise<string | undefined> {
    return this.withLock(() => sanitizeProfile('dsh', this.paths.profile, WEB_PROFILE.bundles))
  }

  /**
   * Load application metadata and prepare the external plugin profile without installing packages.
   */
  async applyRelease(): Promise<void> {
    await this.withLock(async () => {
      const descriptor = readDesktopRuntime(this.runtime.dsh)
      migrateProfileSettings(this.paths.profile)
      await initializeDesktopPlugins(this.paths.profile, descriptor)
      removeLinkProjections(this.paths.profile)
    })
  }

  private async withLock<T>(operation: () => T | Promise<T>): Promise<T> {
    mkdirSync(this.paths.profile, { recursive: true, mode: 0o700 })
    const lockPath = join(realpathSync(this.paths.profile), 'lock')
    let descriptor: number
    try {
      descriptor = openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const lock = lstatSync(lockPath)
        if (lock.isSymbolicLink() || !lock.isFile()) {
          throw new Error('desktop project: profile lock is not a regular file')
        }
        const owner = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
        let active = !Number.isSafeInteger(owner) || owner <= 0
        if (!active) {
          try {
            process.kill(owner, 0)
            active = true
          } catch (signalError) {
            active = (signalError as NodeJS.ErrnoException).code !== 'ESRCH'
          }
        }
        if (active) throw new Error('desktop project: another profile operation is active')
        unlinkSync(lockPath)
        descriptor = openSync(lockPath, 'wx', 0o600)
      } else {
        throw error
      }
    }
    try {
      writeSync(descriptor, `${String(process.pid)}\n`)
      fsyncSync(descriptor)
      return await operation()
    } finally {
      closeSync(descriptor)
      unlinkSync(lockPath)
    }
  }
}

/** Create build-only project metadata for materializing the signed runtime. */
export function createRuntimeProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const packageSet = verifyDesktopCorePackageSet(projectDir, release.version)
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: desktopCorePackageOverrides(packageSet),
    dsh: { profile: { bundles: [...WEB_PROFILE.bundles] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(
    join(projectDir, 'pnpm-workspace.yaml'),
    workspaceFile(desktopCorePackageOverrides(packageSet)),
    { mode: 0o600 },
  )
}

/**
 * Create metadata for the unpackaged development project that links the current workspace.
 * @param projectDir - Disposable development profile directory.
 * @param release - Release identity shared by the linked CLI package and Electron shell.
 */
export function createDevelopmentProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: {
      [DSH_PACKAGE]: release.version,
      [DESKTOP_HOST_PACKAGE]: release.version,
    },
    dsh: { profile: { bundles: [...WEB_PROFILE.bundles] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), workspaceFile(), { mode: 0o600 })
}

/**
 * Initialize the external profile and select the expert bundle when carried by this release.
 * @param projectDir Profile whose caller holds the write lock or owns the temporary directory.
 * @param descriptor Runtime inventory read by Electron or already verified during packaging.
 * @returns Completion of profile initialization and any one-time bundle migration.
 */
export async function initializeDesktopPlugins(projectDir: string, descriptor: DesktopRuntimeDescriptor): Promise<void> {
  createPluginProfile(projectDir)
  if (descriptor.sharedPackages.some(entry => entry.name === DESKTOP_EXPERT_BUNDLE)) {
    await retirePreviousMarketOverrides(projectDir)
  await activateDesktopExpertBundle(projectDir)
  }
}

/** Select the bundled expert preset once without rewriting the user's patch or dependencies. */
async function activateDesktopExpertBundle(projectDir: string): Promise<void> {
  const manifest = readProfileManifest('dsh', projectDir)
  if ('desktopExpertInitialized' in manifest && manifest.desktopExpertInitialized === true) return
  await retirePreviousMarketOverrides(projectDir)
  const selected = manifest.dsh?.profile?.bundles ?? []
  const bundles = selected.filter(name => name !== PREVIOUS_EXPERT_BUNDLE)
  if (!bundles.includes(DESKTOP_EXPERT_BUNDLE)) {
    const previousIndex = selected.indexOf(PREVIOUS_EXPERT_BUNDLE)
    const baseIndex = bundles.lastIndexOf('@deepseek-ai/dsh-web-app') + 1
    bundles.splice(previousIndex === -1 ? baseIndex : previousIndex, 0, DESKTOP_EXPERT_BUNDLE)
  }
  const updated = {
    ...manifest,
    desktopExpertInitialized: true,
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } },
  }
  await writeFileAtomic(join(projectDir, 'package.json'), JSON.stringify(updated, undefined, 2) + '\n', { mode: 0o600 })
}

/** Remove only the previous package's market switch, whose row ids also target the installation-owned remote and preset. */
async function retirePreviousMarketOverrides(projectDir: string): Promise<void> {
  const path = join(projectDir, 'cordis.patch.yml')
  if (!existsSync(path)) return
  const document = parseDocument(readFileSync(path, 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
  const marker = `dsh-market package-switch ${PREVIOUS_EXPERT_BUNDLE}`
  const obsolete = document.contents.items.filter((item, index) => isMap(item)
    && document.getIn([index, 'disabled']) === true
    && item.items.some(pair => isScalar(pair.key) && pair.key.value === 'disabled'
      && isScalar(pair.value) && typeof pair.value.comment === 'string'
      && pair.value.comment.trim() === marker))
  if (obsolete.length === 0) return
  for (const item of obsolete) {
    const index = document.contents.items.indexOf(item)
    const comment = item.commentBefore
    const next = document.contents.items[index + 1]
    if (comment && isMap(next)) next.commentBefore = next.commentBefore ? `${comment}\n${next.commentBefore}` : comment
    else if (comment) document.comment = document.comment ? `${comment}\n${document.comment}` : comment
    document.contents.items.splice(index, 1)
  }
  await writeFileAtomic(path, String(document), { mode: 0o600 })
}

/** Create the first external plugin profile without running a package manager. */
export function createPluginProfile(projectDir: string): void {
  initProfile(projectDir, WEB_PROFILE.bundles)
}
