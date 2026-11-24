import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'

interface Recipe {
  persona: string
  toolFilter: { deny: string[] } | null
  expertName: string
}

const moduleUrl = new URL('../bundled-plugins/bailan-expert-orchestrator/lib/summon-preset.js', import.meta.url)
const { readSummonPreset, saveSummonPreset, summonPresetKey }: {
  readSummonPreset: (dst: string, id: string) => PresetDefinition | undefined
  saveSummonPreset: (dst: string, id: string, input: Recipe) => void
  summonPresetKey: (input: Recipe) => string
} = await import(moduleUrl.href)

const recipe = { persona: 'QA expert persona', toolFilter: { deny: ['summon_expert'] }, expertName: 'QA expert' }
const id = 'expert-orchestrator-summon-' + summonPresetKey(recipe)
const roots: string[] = []
function newRoot() {
  const root = mkdtempSync(join(tmpdir(), 'expert-preset-resume-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('rebuilds the exact saved expert persona and restrictions without using the current expert profile', () => {
  const root = newRoot()
  saveSummonPreset(root, id, recipe)
  saveSummonPreset(root, id, { ...recipe, expertName: 'Renamed expert' })

  const preset = readSummonPreset(root, id)
  expect(preset).toMatchObject({ id, name: expect.stringContaining('QA expert') })
  expect(preset?.plugins[0]).toMatchObject({ id: 'persona', config: { prefix: recipe.persona } })
  expect(preset?.plugins.at(-1)).toMatchObject({ id: 'summon-restrict', config: recipe.toolFilter })
  expect(preset?.plugins.some(row => row.id === 'delegation')).toBe(false)
  expect(readdirSync(join(root, 'summon-presets'))).toEqual([id + '.json'])
})

it('does not restore an unknown id, a path, or a record with changed restrictions', () => {
  const root = newRoot()
  expect(readSummonPreset(root, id)).toBeUndefined()
  expect(readSummonPreset(root, '../expert-sources/teams')).toBeUndefined()

  saveSummonPreset(root, id, recipe)
  const file = join(root, 'summon-presets', id + '.json')
  writeFileSync(file, JSON.stringify({ ...recipe, toolFilter: null }))
  expect(() => readSummonPreset(root, id)).toThrow('does not match its id')
  writeFileSync(file, JSON.stringify({ ...recipe, toolFilter: { deny: [false] } }))
  expect(() => readSummonPreset(root, id)).toThrow('Invalid expert preset recovery record')
})
