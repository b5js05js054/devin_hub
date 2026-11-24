/** Media model parameters: spec lookup against the relay and per-session chosen values. */
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-relay-license'
import type { MediaParams, MediaSpecResult } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `media` Remote namespace and the per-session media parameters. */
    mediaController: MediaController
  }
}

/** Relay location. */
export interface Config {
  /** Origin of the relay server exposing `/v1/media/spec`. */
  relayURL: string
  /** Deadline of one spec request. */
  timeoutMs?: number
}
/** Validated options. */
export const Config = Schema.object({
  relayURL: Schema.string().required(),
  timeoutMs: Schema.number().min(1).max(120_000).default(10_000),
})

const spec = z.object({
  kind: z.enum(['image', 'video']),
  source: z.enum(['upstream', 'builtin']),
  fields: z.array(z.object({
    key: z.string().min(1),
    label: z.string(),
    type: z.enum(['select', 'number']),
    options: z.array(z.string()).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    default: z.union([z.string(), z.number()]).nullable(),
    required: z.boolean(),
  })),
})

/**
 * Normalize the configured origin to the `/v1` base.
 * @param raw - relay origin, optionally already ending in `/v1`.
 * @returns base URL without a trailing slash.
 * @throws Error when it is not an http(s) URL.
 */
function baseURL(raw: string): string {
  const url = new URL(raw)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`media-controller: relayURL must be http(s), got ${url.protocol}`)
  return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`
}

/** Media model parameter spec lookup and the values chosen per session and model. */
export class MediaController extends TypertRemoteService {
  static inject = ['relayLicense']
  static Config = Config
  private readonly base: string
  private readonly timeout: number
  private readonly chosen = new Map<string, MediaParams>()

  /** @param ctx - Host with the relay license mounted. @param config - relay location. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'mediaController', { namespace: 'media' })
    const resolved = Config(config)
    this.base = baseURL(resolved.relayURL)
    this.timeout = resolved.timeoutMs
  }

  /**
   * Ask the relay which parameters a model accepts.
   * @param model - model id as listed by the relay.
   * @returns the spec, or why there is none (`not-media` for chat models).
   */
  @Remote
  async getSpec(model: string): Promise<MediaSpecResult> {
    const creds = await this.ctx.relayLicense.getCredentials()
    if (creds === undefined) return { ok: false, code: 'not-activated', message: 'activate a card key first' }
    let response: Response
    try {
      response = await fetch(`${this.base}/media/spec?model=${encodeURIComponent(model)}`, {
        headers: { authorization: `Bearer ${creds.token}` },
        signal: AbortSignal.timeout(this.timeout),
      })
    } catch (error) {
      return { ok: false, code: 'unavailable', message: error instanceof Error ? error.message : 'network' }
    }
    if (response.status === 404) return { ok: false, code: 'not-media', message: '' }
    if (!response.ok) return { ok: false, code: 'unavailable', message: `HTTP ${String(response.status)}` }
    const parsed = spec.safeParse(await response.json().catch(() => undefined))
    if (!parsed.success) return { ok: false, code: 'unavailable', message: 'unexpected spec shape' }
    return { ok: true, spec: parsed.data }
  }

  /**
   * Remember the parameters the next generation of this model in this session should use.
   * @param sessionId - session whose requests carry the parameters.
   * @param model - media model the values belong to.
   * @param params - chosen values; an empty object clears the choice.
   */
  @Remote
  setParams(sessionId: string, model: string, params: MediaParams): void {
    const key = `${sessionId}\n${model}`
    if (Object.keys(params).length === 0) this.chosen.delete(key)
    else this.chosen.set(key, params)
  }

  /**
   * Look up the media parameters chosen for one session and model.
   * @param sessionId - session issuing the request.
   * @param model - model being called.
   * @returns the chosen values, or `undefined` when none were set.
   */
  paramsOf(sessionId: string, model: string): MediaParams | undefined {
    return this.chosen.get(`${sessionId}\n${model}`)
  }
}
export default MediaController
