import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { stageDesktopExpertBundle } from '../scripts/stage-expert-bundle.ts'

it('reads the root board and delivers a follow-up to a fresh expert with its actual preset', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'summon-team-profile-'))
  const home = join(cwd, '.dsh')
  const profile = join(home, 'profiles', 'headless')
  try {
    const modules = join(profile, 'node_modules', '@deepseek-ai')
    await mkdir(modules, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-headless', private: true,
      dependencies: { '@deepseek-ai/dsh-experimental-agent-team-profile': 'workspace:^' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@deepseek-ai/dsh-experimental-agent-team-profile'] } },
    }))
    // The Desktop runtime supplies the CLI and the expert plugin's dsh-tools peer.
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(fileURLToPath(new URL('../../cli', import.meta.url)), join(modules, 'dsh'), linkType)
    await symlink(fileURLToPath(new URL('../../../packages/core/tools', import.meta.url)), join(modules, 'dsh-tools'), linkType)
    const expertPlugin = stageDesktopExpertBundle(profile)
    const fixtureModel = new URL('../../../packages/experimental/tool-agent-team/tests/summon-team-model.mjs', import.meta.url).href
    await writeFile(join(profile, 'cordis.patch.yml'), `- id: llm-deepseek
  disabled: true
- id: session-title-llm
  disabled: true
- id: tools
  config: { mode: native }
- insert:
    - id: agent-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config: { default: standard }
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config: { id: standard, plugins: [] }
    - id: expert-plugin
      name: '${expertPlugin}'
      config: { autoClaim: false }
    - id: expert-model
      name: '${fixtureModel}'
`)
    const launch = resolveExampleLaunch({
      srcBin: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)),
      sourceImport: 'tsx/esm',
      tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
      configArgs: ['--profile', 'headless', 'LEAD_PRIVATE_HISTORY: ask for a review via the shared board.'],
      env: { DSH_HOME: home, DSH_AGENTS_HOME: join(cwd, '.agents'), DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: '' },
    })
    const result = await execa(launch.command, launch.args, { cwd, env: launch.env, input: '', timeout: 90_000, reject: false })
    expect(result.exitCode, result.stderr + '\n' + result.stdout).toBe(0)
    expect(result.stdout, result.stderr).toContain('Reviewer found Blue checklist. Reviewer received the orange checklist.')
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 3 })
  }
}, 105_000)
