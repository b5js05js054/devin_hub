/** Install the vendored expert package in a disposable Desktop runtime. */
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DESKTOP_EXPERT_BUNDLE } from '../src/expert-bundle.ts'

/**
 * Copy the expert package and declare it alongside the CLI's built-in dependencies.
 * @param root Desktop runtime project with its CLI already materialized.
 * @returns The packaged module name for the runtime inventory.
 */
export function stageDesktopExpertBundle(root: string): string {
  const source = resolve(import.meta.dirname, '..', 'bundled-plugins', DESKTOP_EXPERT_BUNDLE)
  const bundle = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { name: string; version: string }
  if (bundle.name !== DESKTOP_EXPERT_BUNDLE || typeof bundle.version !== 'string') {
    throw new Error(`desktop runtime: invalid expert bundle manifest in ${source}`)
  }
  const modules = join(root, 'node_modules')
  const cli = JSON.parse(readFileSync(join(modules, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as {
    version: string; dependencies?: Record<string, string>
  }
  const anchor = join(root, 'package.json')
  const manifest = JSON.parse(readFileSync(anchor, 'utf8')) as { dependencies?: Record<string, string> }
  cpSync(source, join(modules, DESKTOP_EXPERT_BUNDLE), { recursive: true, force: false, errorOnExist: true })
  manifest.dependencies = { ...cli.dependencies, '@deepseek-ai/dsh': cli.version, ...manifest.dependencies, [bundle.name]: bundle.version }
  writeFileSync(anchor, JSON.stringify(manifest, undefined, 2) + '\n')
  return bundle.name
}
