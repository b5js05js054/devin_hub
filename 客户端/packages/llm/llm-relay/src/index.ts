/** LLM route `relay`: OpenAI-compatible chat through the user's card-key relay server. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiProviderProfile, PiAiReasoningEfforts } from '@deepseek-ai/dsh-llm-pi-ai'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-relay-license'
import type {} from '@deepseek-ai/dsh-api-media-controller'

export const name = 'llm-relay'
export const inject = ['llm', 'relayLicense']

const ROUTE = 'relay'

/** Relay route options. */
export interface Config {
  /** Origin of the relay server exposing `/v1/models` and `/v1/chat/completions`. */
  relayURL: string
  /** Name shown in model pickers. */
  displayName?: string
  /** Listing age after which the next access refreshes it. */
  modelsMaxAgeMs?: number
  /** Deadline of one model-listing request. */
  modelsTimeoutMs?: number
  /** Background poll interval keeping the listing current; 0 disables it. */
  modelsPollMs?: number
}
/** Validated options. */
export const Config = Schema.object({
  relayURL: Schema.string().required(),
  displayName: Schema.string().default('BaiLan'),
  modelsMaxAgeMs: Schema.number().min(0).default(600_000),
  modelsTimeoutMs: Schema.number().min(1).max(120_000).default(10_000),
  modelsPollMs: Schema.number().min(0).default(15_000),
})

const listing = z.object({
  data: z.array(z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    context_window: z.number().int().positive().optional(),
    max_output: z.number().int().positive().optional(),
    supports_thinking: z.boolean().optional(),
    reasoning_efforts: z.array(z.string()).optional(),
    ratio: z.number().min(0).optional(),
    free: z.boolean().optional(),
    input_modalities: z.array(z.enum(['text', 'image'])).optional(),
  })),
})

type Entry = z.infer<typeof listing>['data'][number]

/**
 * Normalize the configured origin to the `/v1` base.
 * @param raw - relay origin, optionally already ending in `/v1`.
 * @returns base URL without a trailing slash.
 * @throws Error when it is not an http(s) URL.
 */
export function relayBaseURL(raw: string): string {
  const url = new URL(raw)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`llm-relay: relayURL must be http(s), got ${url.protocol}`)
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
  return `${url.origin}${path}/v1`
}

const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Map the relay's offered efforts to pi-ai levels; the relay's `none` is pi-ai's valueless `off`.
 * @param efforts - effort names advertised for one model.
 * @returns the selectable levels, or `undefined` to inherit pi-ai's catalog.
 */
function reasoningEffortsOf(efforts: readonly string[] | undefined): PiAiReasoningEfforts | undefined {
  if (efforts === undefined || efforts.length === 0) return undefined
  const out: PiAiReasoningEfforts = {}
  if (efforts.includes('none')) out.off = null
  for (const level of EFFORT_LEVELS) if (efforts.includes(level)) out[level] = level
  return out
}

/**
 * Append the billing badge the backend assigns to a model to its display name.
 * @param entry - one listed model.
 * @returns the display name, or `undefined` when neither a name nor billing info exists.
 */
export function displayNameOf(entry: Pick<Entry, 'id' | 'name' | 'ratio' | 'free'>): string | undefined {
  if (entry.ratio === undefined && entry.free === undefined) return entry.name
  const badge = entry.free === true || entry.ratio === 0 ? '免费'
    : entry.ratio === undefined ? '高级' : `高级 ×${String(Number(entry.ratio.toFixed(2)))}`
  return `${entry.name ?? entry.id} · ${badge}`
}

function profileOf(baseURL: string, displayName: string, entries: readonly Entry[]): PiAiProviderProfile {
  return {
    displayName,
    api: 'openai-completions',
    baseURL,
    models: entries.map((entry) => {
      const reasoningEfforts = reasoningEffortsOf(entry.reasoning_efforts)
      const name = displayNameOf(entry)
      return {
        id: entry.id,
        ...name === undefined ? {} : { name },
        ...entry.context_window === undefined ? {} : { contextWindow: entry.context_window },
        ...entry.max_output === undefined ? {} : { maxTokens: entry.max_output },
        ...entry.input_modalities === undefined || entry.input_modalities.length === 0 ? {} : { input: entry.input_modalities },
        ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
      }
    }),
  }
}

/**
 * Map failure text the relay server authors itself to a retryable code. An in-stream relay error
 * reaches the adapter as its message only, so the relay's no-output and connection diagnostics
 * would otherwise stay unclassified and end the turn without a retry.
 * @param message - failure text of a relay request no other pattern classified.
 * @returns `TIMEOUT` for the relay's no-output watchdogs, `TRANSPORT` for its upstream connection
 *   failure, or `undefined` for text the relay only forwards.
 */
export function relayFailureCode(message: string): 'TIMEOUT' | 'TRANSPORT' | undefined {
  if (/渠道 \d+s 内无有效输出|上游输出停滞: \d+s 无新内容|上游空闲超时 \(\d+s 无数据\)/.test(message)) return 'TIMEOUT'
  if (message.includes('第三方接口连接失败')) return 'TRANSPORT'
  return undefined
}

/** Replace the unclassified code of a relay-authored terminal failure with its retryable code. */
async function* classifyRelayFailures(chunks: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  for await (const chunk of chunks) {
    if (chunk.type === 'finish' && chunk.reason.kind === 'error' && chunk.reason.failure.code === 'PI_AI_ERROR') {
      const code = relayFailureCode(chunk.reason.failure.message)
      if (code !== undefined) {
        yield { ...chunk, reason: { kind: 'error', failure: { ...chunk.reason.failure, code } } }
        continue
      }
    }
    yield chunk
  }
}

/** Adapter that keeps the model list fresh before any listing or request. */
class RelayAdapter extends PiAiAdapter {
  constructor(options: ConstructorParameters<typeof PiAiAdapter>[0], private readonly ensure: () => Promise<void>) {
    super(options)
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return classifyRelayFailures(super.stream(options))
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    await this.ensure()
    return super.listModels(provider)
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.ensure()
    return super.resolveModel(provider, model, signal)
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    await this.ensure()
    const prepared = await super.prepareCall(provider, model, signal)
    return { model: prepared.model, stream: options => classifyRelayFailures(prepared.stream(options)) }
  }
}

export function apply(ctx: Context, config: Config): void {
  const baseURL = relayBaseURL(config.relayURL)
  const displayName = config.displayName ?? 'BaiLan'
  const maxAge = config.modelsMaxAgeMs ?? 600_000
  const timeout = config.modelsTimeoutMs ?? 10_000
  const pollMs = config.modelsPollMs ?? 15_000
  let registration: { replace: (routes: string[]) => void } | undefined
  const lifetime = new AbortController()
  let entries: readonly Entry[] = []
  let loadedAt = Number.NEGATIVE_INFINITY
  let inflight: Promise<void> | undefined
  let memo: { source: readonly Entry[]; profiles: ReturnType<typeof resolveProfiles> } | undefined

  const profiles = () => {
    if (memo?.source !== entries) memo = { source: entries, profiles: resolveProfiles({ [ROUTE]: profileOf(baseURL, displayName, entries) }, 'deferred') }
    return memo.profiles
  }

  const credentials = async () => {
    const creds = await ctx.relayLicense.getCredentials()
    if (creds === undefined) {
      throw new LlmError('llm-relay: activate a card key on the Relay account page to use the relay models', 'MISSING_CREDENTIAL')
    }
    return creds
  }

  const load = async (): Promise<void> => {
    const { token } = await credentials()
    const response = await fetch(`${baseURL}/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeout)]),
    })
    if (!response.ok) throw new LlmError(`llm-relay: model listing failed (HTTP ${String(response.status)})`, 'MODEL_LISTING_FAILED')
    const parsed = listing.safeParse(await response.json())
    if (!parsed.success) throw new LlmError('llm-relay: model listing has an unexpected shape', 'MODEL_LISTING_FAILED')
    const changed = JSON.stringify(entries) !== JSON.stringify(parsed.data.data)
    entries = parsed.data.data
    loadedAt = Date.now()
    if (changed && registration !== undefined && !lifetime.signal.aborted) registration.replace([ROUTE])
  }

  const ensure = async (): Promise<void> => {
    if (Date.now() - loadedAt < maxAge && entries.length > 0) return
    inflight ??= load().finally(() => { inflight = undefined })
    try {
      await inflight
    } catch (error) {
      if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return
      if (entries.length === 0) throw error
    }
  }

  const adapter = new RelayAdapter({
    profiles,
    resolveApiKey: async () => (await credentials()).token,
    resolveHeaders: (options) => {
      const params = options.sessionId === undefined
        ? undefined
        : ctx.get('mediaController')?.paramsOf(String(options.sessionId), options.model)
      return params === undefined ? undefined : { 'X-Relay-Media-Params': JSON.stringify(params) }
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    auth: {
      credentials: {
        read: () => Promise.resolve(undefined),
        list: () => Promise.resolve([]),
        modify: () => Promise.resolve(undefined),
        delete: () => Promise.resolve(),
      },
      authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
    },
  }, ensure)

  ctx.on('relay-license/changed', () => { loadedAt = Number.NEGATIVE_INFINITY })
  ctx.effect(() => ctx.llm.registerConfigurableProviders([{ provider: ROUTE, displayName, settingsNs: 'llm-relay', settingsPath: [] }]), 'llm-relay: provider directory')
  ctx.effect(() => {
    const handle = ctx.llm.registerAdapter([ROUTE], adapter)
    registration = handle
    return () => { registration = undefined; handle() }
  }, 'llm-relay: adapter route')
  if (pollMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        inflight ??= load().finally(() => { inflight = undefined })
        inflight.catch(() => undefined)
      }, pollMs)
      return () => { clearInterval(timer) }
    }, 'llm-relay: background model refresh')
  }
  ctx.effect(() => () => { lifetime.abort() }, 'llm-relay: request lifetime')
}
