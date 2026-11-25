import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as HostPlugin from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import {
  DEFAULT_BUSY_ENTER_BEHAVIOR, Config, apply,
} from '@deepseek-ai/dsh-client-ui-conversation'


describe('ui-conversation host', () => {
  it('defaults an old settings section and validates live changes to both preferences', async () => {
    const ctx = new Context()
    const configuration = await liveConfig(ctx, { Config, apply })
    const { fiber } = configuration
    expect(plainConfig(fiber.config)).toEqual({ busyEnter: DEFAULT_BUSY_ENTER_BEHAVIOR, userPrompt: '' })
    await configuration.update({ busyEnter: 'steer' })
    expect(plainConfig(fiber.config)).toEqual({ busyEnter: 'steer', userPrompt: '' })
    await configuration.update({ userPrompt: '第一行\n第二行' })
    expect(plainConfig(fiber.config)).toEqual({ busyEnter: 'steer', userPrompt: '第一行\n第二行' })
    await expect(configuration.update({ busyEnter: 'invalid' })).rejects.toThrow()
    await expect(configuration.update({ userPrompt: 123 })).rejects.toThrow()
    await configuration.update({ userPrompt: '' })
    expect(plainConfig(fiber.config)).toEqual({ busyEnter: 'steer', userPrompt: '' })
    await fiber.dispose()
  })
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(ctx => ctx.plugin(HostPlugin)))
