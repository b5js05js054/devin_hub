import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProfile, loadProfileDirectory, PROFILE_TEMPLATES, readPluginMeta, readProfileManifest, writeProfileBundles } from '@deepseek-ai/dsh-app-boot'
import { pathToFileURL } from 'node:url'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { writeDesktopRuntime } from '../src/runtime-tree.ts'
import * as staging from '../scripts/stage-expert-bundle.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

const packageName = 'bailan-expert-orchestrator'
const previousName = 'dsh-expert-orchestrator'
const roots: string[] = []

function desktop() {
  const home = mkdtempSync(join(tmpdir(), 'bailan-expert-'))
  roots.push(home)
  const root = join(home, 'application', 'dsh')
  const runtime = runtimeFixture(root)
  const modules = join(root, 'node_modules')
  const installAnchor = join(root, 'package.json')
  const manager = new DesktopProjectManager(resolveDesktopPaths(home), { dsh: root })
  return { root, runtime, modules, installAnchor, manager, profile: manager.paths.profile }
}

function seal(fixture: ReturnType<typeof desktop>) {
  writeDesktopRuntime(fixture.root, fixture.runtime.release,
    [...fixture.runtime.sharedPackages.map(entry => entry.name), packageName])
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('ships the renamed expert bundle in the desktop installation without an upstream source', async () => {
  const { root, modules, installAnchor } = desktop()
  expect(staging.stageDesktopExpertBundle(root)).toBe(packageName)

  const directory = join(modules, packageName)
  const manifest = join(directory, 'package.json')
  expect(existsSync(manifest)).toBe(true)
  const { version, repository, homepage, bugs } = JSON.parse(readFileSync(manifest, 'utf8'))
  expect({ repository, homepage, bugs }).toEqual({ repository: undefined, homepage: undefined, bugs: undefined })
  expect(JSON.parse(readFileSync(installAnchor, 'utf8')).dependencies[packageName]).toBe(version)
  const metadata = readPluginMeta(packageName, pathToFileURL(manifest).href)
  expect(metadata?.title).toMatchObject({ zh: '白岚专家提供' })
  for (const file of ['lib/client.js', 'lib/summon-job.js', 'skills/expert-orchestration/tools/taskboard.py', 'LICENSE', 'NOTICE']) {
    expect(existsSync(join(directory, file)), file).toBe(true)
  }
})

it('activates the installation-owned bundle for a new desktop profile', async () => {
  const fixture = desktop()
  const directory = writePackage(fixture.modules, packageName, { dsh: { bundle: { patch: './bundle.yml' } } })
  writeFileSync(join(directory, 'bundle.yml'), '[]\n')
  seal(fixture)

  await fixture.manager.applyRelease()

  const manifest = readProfileManifest('dsh', fixture.profile)
  expect(manifest.dsh?.profile?.bundles).toContain(packageName)
  expect(manifest.dependencies).not.toHaveProperty(packageName)
  expect(loadProfileDirectory('dsh', fixture.profile, fixture.installAnchor).layers.find(layer => layer.packageName === packageName)?.packageDir).toBe(directory)
})

it('adds the expert bundle to an existing desktop profile and leaves later disablement in place', async () => {
  const fixture = desktop()
  writePackage(fixture.modules, packageName)
  seal(fixture)
  initProfile(fixture.profile, [...PROFILE_TEMPLATES.web!.bundles, 'other-local-plugin'])
  const userPatch = join(fixture.profile, 'cordis.patch.yml')
  writeFileSync(userPatch, '# User settings\n[]\n')
  writeFileSync(join(fixture.profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')

  await fixture.manager.applyRelease()

  const migrated = readProfileManifest('dsh', fixture.profile)
  expect(migrated.dsh?.profile?.bundles).toEqual([...PROFILE_TEMPLATES.web!.bundles, packageName, 'other-local-plugin'])
  writeProfileBundles(fixture.profile, migrated, [...PROFILE_TEMPLATES.web!.bundles, 'other-local-plugin'])
  await fixture.manager.applyRelease()
  expect(readProfileManifest('dsh', fixture.profile).dsh?.profile?.bundles).not.toContain(packageName)
  expect(readFileSync(userPatch, 'utf8')).toBe('# User settings\n[]\n')
  expect(readFileSync(join(fixture.profile, 'pnpm-lock.yaml'), 'utf8')).toBe('lockfileVersion: 9.0\n')
})

it('retires only the old market overrides that also disable the bundled remote and preset', async () => {
  const fixture = desktop()
  writePackage(fixture.modules, packageName)
  seal(fixture)
  initProfile(fixture.profile, [...PROFILE_TEMPLATES.web!.bundles, previousName])
  const userPatch = join(fixture.profile, 'cordis.patch.yml')
  writeFileSync(userPatch, '# Keep user comments and unrelated settings.\n'
    + '- id: dsh-expert-orchestrator\n'
    + '  disabled: true # dsh-market package-switch dsh-expert-orchestrator\n'
    + "  name: 'dsh-expert-orchestrator' # dsh-market\n"
    + '- id: expert-sources-remote\n'
    + '  disabled: true # dsh-market package-switch dsh-expert-orchestrator\n'
    + '- id: preset-expert-orchestrator\n'
    + '  disabled: true # dsh-market package-switch dsh-expert-orchestrator\n'
    + "  name: '@deepseek-ai/dsh-agent-preset' # dsh-market\n"
    + '- id: other-plugin\n'
    + '  disabled: true # dsh-market package-switch other-plugin\n')

  const manifest = readProfileManifest('dsh', fixture.profile)
  writeFileSync(join(fixture.profile, 'package.json'), JSON.stringify({ ...manifest, desktopExpertInitialized: true }))

  await fixture.manager.applyRelease()

  expect(readFileSync(userPatch, 'utf8')).toBe('# Keep user comments and unrelated settings.\n'
    + '- id: other-plugin\n'
    + '  disabled: true # dsh-market package-switch other-plugin\n')
  const afterMigration = readFileSync(userPatch, 'utf8')
  await fixture.manager.applyRelease()
  expect(readFileSync(userPatch, 'utf8')).toBe(afterMigration)
})

it('preserves an ordinary user disablement of the bundled remote and preset', async () => {
  const fixture = desktop()
  writePackage(fixture.modules, packageName)
  seal(fixture)
  initProfile(fixture.profile, [...PROFILE_TEMPLATES.web!.bundles, previousName])
  const userPatch = join(fixture.profile, 'cordis.patch.yml')
  const userDisabled = '- id: expert-sources-remote\n  disabled: true\n'
    + '- id: preset-expert-orchestrator\n  disabled: true\n'
    + '- id: expert-sources-remote\n  disabled: true # dsh-market package-switch dsh-expert\n'
  writeFileSync(userPatch, userDisabled)

  await fixture.manager.applyRelease()

  expect(readFileSync(userPatch, 'utf8')).toBe(userDisabled)
})

it('replaces a selected old bundle without removing the user-installed package', async () => {
  const fixture = desktop()
  writePackage(fixture.modules, packageName)
  seal(fixture)
  initProfile(fixture.profile, [...PROFILE_TEMPLATES.web!.bundles, previousName])
  const manifestPath = join(fixture.profile, 'package.json')
  const oldManifest = readProfileManifest('dsh', fixture.profile)
  writeFileSync(manifestPath, JSON.stringify({ ...oldManifest, dependencies: { [previousName]: '2.9.8' } }))

  await fixture.manager.applyRelease()

  const migrated = readProfileManifest('dsh', fixture.profile)
  expect(migrated.dsh?.profile?.bundles).toEqual([...PROFILE_TEMPLATES.web!.bundles, packageName])
  expect(migrated.dependencies?.[previousName]).toBe('2.9.8')
})
