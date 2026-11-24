// @vitest-environment jsdom
/** Section, setup-card, and hand-written editor behavior over a scripted wire face. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  CredentialInfo, RemoteResult, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  ModelsSection, needsSetup, providerCopy, providerTargetLabel, removeProviderProfile,
} from '../src/client/ModelsSection.tsx'
import type { ModelsSectionInjected, ModelsSectionProps } from '../src/client/ModelsSection.tsx'
import { ProviderEditor, pathOps } from '../src/client/ProviderEditor.tsx'
import type { ProviderEditorProps } from '../src/client/ProviderEditor.tsx'
import {
  DeepSeekModelsEditor, formatCapacity, modelDrafts, parseCapacity, validateDeepSeekModels,
} from '../src/client/DeepSeekModelsEditor.tsx'
import { apiKeyFailure } from '../src/client/apiKey.ts'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { deriveKeyRef, ModelsSettingsStore } from '../src/client/store.ts'
import { createModelsOperations } from '../src/client/operations.ts'
import type { ModelsOperations } from '../src/client/operations.ts'
import type { ProviderRow } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => en[key]
const OPENAI_TARGET = { provider: 'openai', displayName: 'openai' }
const openaiCopy = (template: string): string => providerCopy(template, OPENAI_TARGET)
const DEEPSEEK_TARGET = { provider: 'deepseek-official', displayName: 'DeepSeek' }
const deepSeekCopy = (template: string): string => providerCopy(template, DEEPSEEK_TARGET)

/** Open one row's capacity disclosure (1-based, as the labels read). */
function expandRow(position: number): void {
  fireEvent.click(screen.getByLabelText(`${en.modelAdvanced} ${String(position)}`))
}

const PiAiConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKeyEnv: Schema.string().role('credential-ref'),
    api: Schema.union(['openai-completions', 'openai-responses', 'anthropic-messages']),
    baseURL: Schema.string(),
    reasoning: Schema.union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
    headers: Schema.dict(Schema.string()),
  })),
})

const DeepSeekConfig = Schema.object({
  apiKeyEnv: Schema.string().role('credential-ref'),
  baseURL: Schema.string().pattern(/^https:\/\//),
  reasoningEffort: Schema.union(['off', 'low', 'high', 'max']),
  defaultContextWindow: Schema.number().step(1).min(1),
  models: Schema.array(Schema.object({
    id: Schema.string().required(),
    name: Schema.string(),
    description: Schema.string(),
    contextWindow: Schema.number().step(1).min(1),
  // The adapter declares its catalog as a schema default rather than a
  // composition entry, which is what the restore-defaults path has to read.
  })).default([
    {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek-V4-Flash',
      description: '',
      contextWindow: 1_000_000,
    },
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek-V4-Pro',
      description: '',
      contextWindow: 1_000_000,
    },
  ]),
})

const DEFAULT_DEEPSEEK_MODELS = [
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek-V4-Flash',
    description: 'Preserved hidden detail',
    contextWindow: 1_000_000,
  },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000 },
]

function wireNamespaces(): SettingsNamespaceView[] {
  return [
    {
      ns: 'llm-deepseek',
      schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as JsonValue,
      value: {
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        baseURL: 'https://base',
        defaultContextWindow: 1_000_000,
        maxTokens: 256_000,
        models: DEFAULT_DEEPSEEK_MODELS,
      },
      base: { defaultContextWindow: 1_000_000, maxTokens: 256_000, models: DEFAULT_DEEPSEEK_MODELS },
      user: { baseURL: 'https://base' },
      autoGenerate: true, applies: 'live',
      secrets: [],
      revision: 0,
    },
    {
      ns: 'llm-plain',
      schema: JSON.parse(JSON.stringify(Schema.object({
        profiles: Schema.dict(Schema.object({ note: Schema.string() })),
      }).toJSON())) as JsonValue,
      value: {},
      autoGenerate: true, applies: 'live',
      secrets: [],
      revision: 0,
    },
    {
      ns: 'llm-pi-ai',
      schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as JsonValue,
      value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://proxy', headers: { 'X-Team': 'a' } }, zombie: {} } },
      user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://proxy', headers: { 'X-Team': 'a' } }, zombie: {} } },
      autoGenerate: true, applies: 'live',
      secrets: [],
      revision: 0,
    },
    {
      ns: 'subagent-model-selection',
      schema: JSON.parse(JSON.stringify(Schema.object({ enabled: Schema.boolean().default(false) }).toJSON())) as JsonValue,
      value: { enabled: false },
      autoGenerate: true, applies: 'live',
      secrets: [],
      revision: 4,
    },
    {
      ns: 'llm-deepseek-account',
      schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as JsonValue,
      value: {
        baseURL: 'https://base',
        defaultContextWindow: 1_000_000,
        maxTokens: 256_000,
        models: DEFAULT_DEEPSEEK_MODELS,
      },
      base: { defaultContextWindow: 1_000_000, maxTokens: 256_000, models: DEFAULT_DEEPSEEK_MODELS },
      user: {},
      autoGenerate: true, applies: 'live',
      secrets: [],
      revision: 0,
    },
  ]
}

/** Credentials answers over the Remote carrier, which has no envelope. */
function remoteOk<T>(value: T) {
  return { ok: true as const, value }
}
/** The codes this page's scripted Host answers refuse with. */
type RefusalCode = 'credential/rejected' | 'gateway/internal' | 'settings/conflict' | 'settings/rejected'

/** One refusal per code, each carrying the details its own code declares. */
const REFUSALS: { [Code in RefusalCode]: (message: string) => RemoteError<Code> } = {
  'credential/rejected': message => new RemoteError('credential/rejected', message, { ref: 'DEEPSEEK_API_KEY' }),
  'gateway/internal': message => new RemoteError('gateway/internal', message, {}),
  'settings/conflict': message =>
    new RemoteError('settings/conflict', message, { ns: 'llm-pi-ai', expected: 4, actual: 5 }),
  'settings/rejected': message => new RemoteError('settings/rejected', message, { ns: 'llm-pi-ai' }),
}
function remoteFail(message: string, code: RefusalCode = 'credential/rejected') {
  return { ok: false as const, error: REFUSALS[code](message) }
}

function scriptedFace(overrides: {
  update?: ReturnType<typeof vi.fn>
  mutate?: ReturnType<typeof vi.fn>
  set?: ReturnType<typeof vi.fn>
  unset?: ReturnType<typeof vi.fn>
} = {}) {
  const providerNamespace = wireNamespaces().find(view => view.ns === 'llm-pi-ai')!
  const update = overrides.update ?? vi.fn(() => Promise.resolve(remoteOk(providerNamespace)))
  const mutate = overrides.mutate ?? vi.fn(() => Promise.resolve(remoteOk(providerNamespace)))
  const set = overrides.set ?? vi.fn(() => Promise.resolve(remoteOk(undefined)))
  const unset = overrides.unset ?? vi.fn(() => Promise.resolve(remoteOk(undefined)))
  const face = {
    llm: {
      listProviders: vi.fn((): ReturnType<PageContext['remote']['llm']['listProviders']> => Promise.resolve(remoteOk([
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'openai', name: 'openai' },
      ]))),
      listConfigurableProviders: vi.fn(() => Promise.resolve(remoteOk([
        { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
        {
          provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true,
          defaultBaseURL: 'https://api.openai.com/v1', baseURLEnv: ['FIXTURE_ENDPOINT'], nativeAuth: { env: ['OPENAI_API_KEY'], oauth: false },
        },
        {
          provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false,
          defaultBaseURL: 'https://api.anthropic.com', baseURLEnv: ['FIXTURE_ENDPOINT'],
          nativeAuth: { env: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], oauth: true },
        },
        { provider: 'zombie', displayName: 'zombie', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'zombie'], active: false },
        { provider: 'broken', displayName: 'broken', settingsNs: 'llm-pi-ai', settingsPath: ['nope', 'x'], active: false },
        { provider: 'plain', displayName: 'plain', settingsNs: 'llm-plain', settingsPath: ['profiles', 'plain'], active: false },
      ].map(({ active: _active, ...entry }) => entry)))),
      discoverModels: vi.fn(() => Promise.resolve(remoteOk([]))),
    },
    settings: {
      describe: vi.fn(() => Promise.resolve(remoteOk({ writable: true, hasDocument: false, namespaces: wireNamespaces() }))),
      update,
      mutate,
    },
    credentials: {
      // Typed as the Remote answer rather than the success branch alone: a
      // case that scripts a refusal replaces this mock.
      describe: vi.fn((refs: string[]): Promise<RemoteResult<Record<string, CredentialInfo>>> =>
        Promise.resolve(remoteOk(
          Object.fromEntries(refs.map(ref => [ref, {
            configured: ref === 'OPENAI_API_KEY',
            ...ref === 'OPENAI_API_KEY' ? { source: 'file' } : {},
            writable: true,
          }])),
        ))),
      set,
      unset,
    },
  }
  return { face, update, mutate, set, unset }
}

type PageContext = ConstructorParameters<typeof ModelsSettingsStore>[0]

/**
 * The page plugin's context, scripted down to the namespaces the page reaches.
 * One context per face, as in production: an editor effect keyed by the context
 * would otherwise re-probe on every render.
 */
const contexts = new WeakMap<object, PageContext>()
function ctxWith(face: object): PageContext {
  const existing = contexts.get(face)
  if (existing !== undefined) return existing
  const ctx = Object.assign(new Context(), { remote: { ...face,
    session: { initializeDefaultModel: async () => ({ ok: true, value: undefined }) },
  } })
  contexts.set(face, ctx)
  return ctx
}

/**
 * The cards' injected Host operations over the same script, bound once per face
 * as the plugin body binds them: an editor effect keyed by this face would
 * otherwise re-probe on every render.
 */
const operations = new WeakMap<object, ModelsOperations>()
function operationsWith(face: object): ModelsOperations {
  const existing = operations.get(face)
  if (existing !== undefined) return existing
  const bound = createModelsOperations(ctxWith(face))
  operations.set(face, bound)
  return bound
}

/** The pi-ai namespace with one more route profile stored in the user layer. */
function piAiNamespaceWith(provider: string, profile: { [key: string]: JsonValue }): SettingsNamespaceView {
  const namespace = wireNamespaces().find(view => view.ns === 'llm-pi-ai')!
  const providers = { ...(namespace.value as { providers: object }).providers, [provider]: profile }
  return { ...namespace, value: { providers }, user: { providers } }
}

/** Render one pi-ai route's editor with the directory and credential facts the page already holds. */
function renderPiAiEditor(
  provider: string,
  namespace: SettingsNamespaceView,
  facts: Pick<ProviderEditorProps, 'defaultBaseURL' | 'baseURLEnv' | 'nativeAuth' | 'credential' | 'credentialChecks'> = {},
): void {
  render(<ProviderEditor provider={provider} displayName={provider}
    namespace={namespace} settingsPath={['providers', provider]} schema={settingsSchema}
    operations={operationsWith(scriptedFace().face)} t={t} readOnly={false} onClose={vi.fn()} {...facts} />)
}

/** Hover the key label's help button and read its tooltip; null when the label has no button. */
function authHelpText(): string | null {
  const button = screen.queryByRole('button', { name: en.authHelp })
  if (button === null) return null
  fireEvent.mouseEnter(button)
  return screen.getByRole('tooltip').textContent
}

/** One recorded child-slot dispatch: seat name, owner share, kind options. */
type RenderSlotCall = [name: string, owner: Record<string, unknown>, opts?: { entryKey?: string }]

/** Child-slot dispatch stub: records every seat occurrence, renders nothing. */
function stubRenderSlot() {
  return vi.fn((..._call: RenderSlotCall) => null)
}

/** The provider-card seat dispatches a stub recorded, as (route id, configured, keyConfigured, entryKey). */
function cardSeatCalls(
  renderSlot: ReturnType<typeof stubRenderSlot>,
): Array<[string, boolean, boolean, string | undefined]> {
  return renderSlot.mock.calls
    .filter(call => call[0] === 'settings.models.provider-card')
    .map(call => [
      (call[1] as { provider: { provider: string } }).provider.provider,
      (call[1] as { configured: boolean }).configured,
      (call[1] as { keyConfigured: boolean }).keyConfigured,
      call[2]?.entryKey,
    ])
}

async function mountFace(scripted: ReturnType<typeof scriptedFace>) {
  const { face, update, mutate, set, unset } = scripted
  const ctx = ctxWith(face)
  const mirror = new SettingsDescribeMirror(ctx)
  const controller = new ModelsSettingsStore(ctx, settingsSchema, mirror)
  await controller.load()
  const renderSlot = stubRenderSlot()
  const injected: ModelsSectionProps = {
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    operations: operationsWith(face),
    schema: settingsSchema,
    t,
    renderSlot: renderSlot as unknown as ModelsSectionProps['renderSlot'],
  }
  const view = render(<ModelsSection {...injected} />)
  return { view, ctx, face, update, mutate, set, unset, controller, mirror, renderSlot }
}

async function mountSection(overrides: Parameters<typeof scriptedFace>[0] = {}) {
  return mountFace(scriptedFace(overrides))
}

/**
 * Mount for a user who cannot reach any provider yet: no credential is stored
 * anywhere, so the whole-section DeepSeek route owns the first-run setup card.
 */
async function mountFirstRun(overrides: Parameters<typeof scriptedFace>[0] = {}) {
  const scripted = scriptedFace(overrides)
  scripted.face.credentials.describe.mockImplementation((refs: string[]) =>
    Promise.resolve(remoteOk(
      Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])),
    )))
  return mountFace(scripted)
}

describe('ModelsSection', () => {

  it('waits for the current snapshot when a setup surface remounts during refresh', async () => {
    const { view, controller, face, mirror, mutate } = await mountFirstRun()
    view.unmount()
    const before = controller.store.getSnapshot().namespaces.get('llm-deepseek')!
    mirror.acceptView({
      ...before,
      value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://current.example', models: DEFAULT_DEEPSEEK_MODELS },
      user: { baseURL: 'https://current.example' },
      revision: 1,
    })
    const read = Promise.withResolvers<RemoteResult<Record<string, CredentialInfo>>>()
    const started = Promise.withResolvers<undefined>()
    face.credentials.describe.mockImplementationOnce(() => { started.resolve(undefined); return read.promise })
    let refreshing: Promise<void> | undefined
    try {
      await act(async () => { refreshing = controller.load(); await started.promise })
      expect(controller.store.getSnapshot().namespaces.get('llm-deepseek')?.revision).toBe(0)
      render(<ModelsSection
        controller={controller}
        useSnapshot={bindSnapshotSelector(controller.store)}
        operations={operationsWith(face)}
        schema={settingsSchema}
        t={t}
        renderSlot={() => null}
      />)
      expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
      expect(screen.queryByLabelText(en.keyInput)).toBeNull()
      expect(screen.queryByRole('button', { name: en.add })).toBeNull()
    } finally {
      await act(async () => { read.resolve(remoteOk({})); await refreshing })
    }
    await screen.findByLabelText(en.keyInput)
    fireEvent.click(screen.getByText(en.customized))
    const url = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    expect(url.value).toBe('https://current.example')
    fireEvent.change(url, { target: { value: 'https://next.example' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledWith(
      'llm-deepseek', [{ op: 'set', path: ['baseURL'], value: 'https://next.example' }], 1,
    ) })
    await screen.findByRole('status')
  })

  it('waits for the current snapshot before remounting setup after a failed page load', async () => {
    const { controller, face, mirror, mutate } = await mountFirstRun()
    const oldKey = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    fireEvent.change(oldKey, { target: { value: 'sk-discarded-on-error' } })
    face.llm.listProviders.mockResolvedValueOnce(remoteFail('directory unavailable', 'gateway/internal'))
    await act(async () => { await controller.load() })
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    expect(screen.getByText(`${en.loadFailed}: directory unavailable`)).toBeTruthy()
    const before = controller.store.getSnapshot().namespaces.get('llm-deepseek')!
    mirror.acceptView({
      ...before,
      value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://recovered.example', models: DEFAULT_DEEPSEEK_MODELS },
      user: { baseURL: 'https://recovered.example' },
      revision: 2,
    })
    const read = Promise.withResolvers<RemoteResult<Record<string, CredentialInfo>>>()
    const started = Promise.withResolvers<undefined>()
    const describe = face.credentials.describe.getMockImplementation()!
    face.credentials.describe.mockImplementation((refs) => {
      if (refs.length > 1) { started.resolve(undefined); return read.promise }
      return describe(refs)
    })
    const load = vi.spyOn(controller, 'load')
    try {
      fireEvent.click(screen.getByRole('button', { name: en.retry }))
      await act(async () => { await started.promise })
      expect(load).toHaveBeenCalledOnce()
      expect(controller.store.getSnapshot()).toMatchObject({ status: 'loading' })
      expect(controller.store.getSnapshot().namespaces.get('llm-deepseek')?.revision).toBe(0)
      expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
      expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    } finally {
      await act(async () => { read.resolve(remoteOk({})); await load.mock.results[0]?.value })
      load.mockRestore()
    }
    const key = await screen.findByLabelText<HTMLInputElement>(en.keyInput)
    expect(key).not.toBe(oldKey)
    expect(key.value).toBe('')
    fireEvent.click(screen.getByText(en.customized))
    const url = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    expect(url.value).toBe('https://recovered.example')
    fireEvent.change(url, { target: { value: 'https://after-retry.example' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledWith(
      'llm-deepseek', [{ op: 'set', path: ['baseURL'], value: 'https://after-retry.example' }], 2,
    ) })
    await screen.findByRole('status')
  })

  it('preserves a mounted setup draft while its current refresh is pending', async () => {
    const { controller, face } = await mountFirstRun()
    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    fireEvent.change(key, { target: { value: 'sk-unsaved-setup-draft' } })
    const read = Promise.withResolvers<RemoteResult<Record<string, CredentialInfo>>>()
    face.credentials.describe.mockImplementationOnce(() => read.promise)
    let refreshing: Promise<void> | undefined
    try {
      act(() => { refreshing = controller.load() })
      expect(screen.getByLabelText(en.keyInput)).toBe(key)
      expect(key.value).toBe('sk-unsaved-setup-draft')
    } finally {
      await act(async () => { read.resolve(remoteOk({})); await refreshing })
    }
    expect(screen.getByLabelText(en.keyInput)).toBe(key)
    expect(key.value).toBe('sk-unsaved-setup-draft')
  })

  it('hides the add action when no settings namespace can open an editor', async () => {
    const scripted = scriptedFace()
    scripted.face.settings.describe.mockResolvedValue(remoteOk({ writable: true, hasDocument: false, namespaces: [] }))
    await mountFace(scripted)
    expect(screen.queryByRole('button', { name: en.add })).toBeNull()
  })

  it('renders nothing before the slot injects its dependencies', () => {
    const uninjected = {} as ModelsSectionProps
    render(<ModelsSection {...uninjected} />)
    expect(document.body.textContent).toBe('')
  })

  it('shows a configuration diagnostic inside the first-run setup card', async () => {
    const scripted = scriptedFace()
    const failure = 'The provider configuration needs repair'
    scripted.face.llm.listProviders.mockResolvedValue(remoteOk([
      { id: 'deepseek-official', name: 'DeepSeek' },
    ]))
    scripted.face.llm.listConfigurableProviders.mockResolvedValue(remoteOk([
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], error: failure },
    ]))
    scripted.face.credentials.describe.mockResolvedValue(remoteOk({
      DEEPSEEK_API_KEY: { configured: false, writable: true },
    }))
    await mountFace(scripted)

    const card = screen.getByRole('listitem')
    expect(within(card).getByRole('alert').textContent).toBe(failure)
    expect(within(card).getByLabelText(en.keyInput)).toBeTruthy()
    expect(within(card).queryByRole('button', { name: deepSeekCopy(en.editProvider) })).toBeNull()
  })

  it('dispatches the provider-card seat per rendered row, keyed by the owning namespace', async () => {
    const { renderSlot } = await mountSection()
    const cards = cardSeatCalls(renderSlot)
    expect(cards).toContainEqual(['openai', true, true, 'llm-pi-ai'])
    expect(cards).toContainEqual(['deepseek-official', true, false, 'llm-deepseek'])
    // The footer seat renders once below the rows and the add controls.
    expect(renderSlot.mock.calls.filter(call => call[0] === 'settings.models.footer')).toEqual([
      ['settings.models.footer', {}],
    ])
  })

  it('dispatches the provider-card seat inside the first-run setup card', async () => {
    const { renderSlot } = await mountFirstRun()
    expect(cardSeatCalls(renderSlot)).toContainEqual(['deepseek-official', true, false, 'llm-deepseek'])
  })

  it('marks only a confirmed missing reference and leaves native or unavailable state unmarked', async () => {
    const { face } = scriptedFace()
    face.credentials.describe.mockImplementation((refs: string[]) => Promise.resolve(remoteOk(
      Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])),
    )))
    const controller = new ModelsSettingsStore(ctxWith(face), settingsSchema, new SettingsDescribeMirror(ctxWith(face)))
    await controller.load()
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      operations={operationsWith(face)}
      schema={settingsSchema}
      t={t}
      renderSlot={() => null}
    />)

    const missing = screen.getByRole('img', { name: en.credentialMissing })
    expect(missing.getAttribute('title')).toBe(en.credentialMissing)
    expect(missing.className).toContain('credentialDotMissing')
    expect(missing.closest('li')?.textContent).toContain('openai')
    expect(screen.queryByRole('img', { name: en.credentialConfigured })).toBeNull()
    expect(screen.getByText('zombie').closest('li')?.querySelector('[role="img"]')).toBeNull()
  })

  it('decides setup need from the joined credential state and the first-run posture', () => {
    const entry = { provider: 'p', displayName: 'p', settingsNs: 'llm-deepseek', settingsPath: [], active: true }
    const row = (credential: ProviderRow['credential']): ProviderRow => ({
      entry,
      configured: true,
      removable: false,
      apiKeyEnv: 'X',
      credential,
    })
    expect(needsSetup(row(undefined), false)).toBe(true)
    expect(needsSetup(row({ configured: true, writable: true }), false)).toBe(false)
    const nested = { ...row(undefined), entry: { ...entry, settingsPath: ['providers', 'x'] } }
    expect(needsSetup(nested, false)).toBe(false)
    // A user who can already reach some provider is not in the first-run
    // posture, so nothing on the page opens itself.
    expect(needsSetup(row(undefined), true)).toBe(false)
  })

  it('derives conventional credential references from route ids', () => {
    expect(deriveKeyRef('anthropic')).toBe('ANTHROPIC_API_KEY')
    expect(deriveKeyRef('minimax-cn')).toBe('MINIMAX_CN_API_KEY')
  })

  it('uses one stable provider identity in action copy', () => {
    const target = { provider: 'deepseek-official', displayName: 'DeepSeek' }
    expect(providerTargetLabel(target)).toBe('DeepSeek (deepseek-official)')
    expect(providerCopy(en.deleteTitle, target)).toBe('Delete DeepSeek (deepseek-official)?')
    expect(providerTargetLabel(OPENAI_TARGET)).toBe('openai')
  })

  it('names only changed fields instead of rebuilding the section', () => {
    expect(pathOps(['providers', 'openai'], { baseURL: 'https://old', reasoning: 'high' }, { reasoning: 'high' }))
      .toEqual([{ op: 'unset', path: ['providers', 'openai', 'baseURL'] }])
    expect(pathOps([], { b: 1 }, { b: 2, d: 3 }))
      .toEqual([{ op: 'set', path: ['b'], value: 2 }, { op: 'set', path: ['d'], value: 3 }])
    expect(pathOps([], undefined, {})).toEqual([])
    expect(pathOps([], { a: 1 }, { a: 1 })).toEqual([])
  })

  it('reuses the provider editor as a required credential-only onboarding form', async () => {
    let finishSet: ((response: { ok: true; value: undefined }) => void) | undefined
    const set = vi.fn(() => new Promise<{ ok: true; value: undefined }>((resolve) => {
      finishSet = resolve
    }))
    const { face, mutate } = scriptedFace({ set })
    const onClose = vi.fn()
    const { ProviderEditor } = await import('../src/client/ProviderEditor.tsx')

    render(<ProviderEditor
      provider="deepseek-official"
      displayName="DeepSeek"
      hideTitle
      namespace={wireNamespaces()[0]!}
      schema={settingsSchema}
      settingsPath={[]}
      operations={operationsWith(face)}
      t={t}
      readOnly={false}
      credentialOnly
      credentialRequired
      autoFocusCredential
      cancelLabelKey="onboardingLater"
      submitLabelKey="onboardingSave"
      submitBusyLabelKey="onboardingSaving"
      onClose={onClose}
    />)

    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    const save = screen.getByText<HTMLButtonElement>(en.onboardingSave)
    expect(document.activeElement).toBe(key)
    expect(key.required).toBe(true)
    expect(save.disabled).toBe(true)
    expect(screen.getByText(en.onboardingLater)).toBeTruthy()
    expect(screen.queryByText(en.customized)).toBeNull()
    expect(screen.queryByLabelText(en.baseUrl)).toBeNull()

    fireEvent.change(key, { target: { value: '   ' } })
    expect(screen.getByText(en.keyRequired)).toBeTruthy()
    expect(key.getAttribute('aria-invalid')).toBe('true')
    expect(save.disabled).toBe(true)

    fireEvent.change(key, { target: { value: '  sk-onboarding  ' } })
    expect(screen.queryByText(en.keyRequired)).toBeNull()
    expect(save.disabled).toBe(false)
    fireEvent.click(save)

    expect(await screen.findByText(en.onboardingSaving)).toBeTruthy()
    expect(set).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'sk-onboarding')
    expect(mutate).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    if (finishSet === undefined) throw new Error('credential write did not start')
    await act(async () => {
      finishSet?.(remoteOk(undefined))
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledWith(true)
  })

  it('edits the DeepSeek endpoint and credential without a protocol selection', async () => {
    const namespace: SettingsNamespaceView = {
      ...wireNamespaces()[0]!,
      ns: 'llm-deepseek',
      value: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: DEFAULT_DEEPSEEK_MODELS },
      user: {},
    }
    const { face, mutate, set } = scriptedFace({
      mutate: vi.fn(() => Promise.resolve(remoteOk(namespace))),
    })
    const { ProviderEditor } = await import('../src/client/ProviderEditor.tsx')
    render(<ProviderEditor
      provider="deepseek-official"
      displayName="DeepSeek"
      namespace={namespace}
      schema={settingsSchema}
      settingsPath={[]}
      operations={operationsWith(face)}
      t={t}
      readOnly={false}
      onClose={vi.fn()}
    />)
    fireEvent.click(screen.getByText(en.customized))
    expect(screen.getByLabelText<HTMLInputElement>(en.baseUrl).placeholder)
      .toBe('https://api.deepseek.com/anthropic (Default to use DEEPSEEK_BASE_URL)')
    expect(screen.queryByLabelText(en.customApi)).toBeNull()
    expect(screen.getByText(en.deepSeekEndpointHint)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-messages-test' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://messages.example/anthropic' } })
    fireEvent.change(screen.getByLabelText(`${en.modelName} 1`), { target: { value: 'Messages Flash' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(set).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'sk-messages-test') })
    expect(mutate.mock.calls).toEqual([[
      'llm-deepseek',
      [
        { op: 'set', path: ['baseURL'], value: 'https://messages.example/anthropic' },
        { op: 'set', path: ['models'], value: [
          { ...DEFAULT_DEEPSEEK_MODELS[0], name: 'Messages Flash' },
          DEFAULT_DEEPSEEK_MODELS[1],
        ] },
      ],
      0,
    ]])
  })

  it('validates every adapter-owned model catalog invariant', () => {
    expect(modelDrafts(undefined)).toEqual([])
    expect(modelDrafts([null, 'bad', { id: 'ok' }])).toEqual([{}, {}, { id: 'ok' }])
    expect(validateDeepSeekModels([{}])).toEqual({ index: 0, key: 'modelIdRequired' })
    expect(validateDeepSeekModels([{ id: 'same' }, { id: 'same' }]))
      .toEqual({ index: 1, key: 'modelIdDuplicate' })
    expect(validateDeepSeekModels([{ id: 'model', name: '' }]))
      .toEqual({ index: 0, key: 'modelNameInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', contextWindow: null }]))
      .toEqual({ index: 0, key: 'modelContextInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', contextWindow: 1.5 }]))
      .toEqual({ index: 0, key: 'modelContextInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', contextWindow: 0 }]))
      .toEqual({ index: 0, key: 'modelContextInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', contextWindow: 1 }])).toBeUndefined()
    expect(validateDeepSeekModels([{ id: 'model', maxTokens: null }]))
      .toEqual({ index: 0, key: 'modelMaxTokensInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', maxTokens: 1.5 }]))
      .toEqual({ index: 0, key: 'modelMaxTokensInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', maxTokens: 0 }]))
      .toEqual({ index: 0, key: 'modelMaxTokensInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', maxTokens: 8192 }])).toBeUndefined()
  })

  it('reads context windows written as counts, thousands, or millions', () => {
    expect(parseCapacity('')).toBeUndefined()
    expect(parseCapacity('   ')).toBeUndefined()
    expect(parseCapacity('131072')).toBe(131_072)
    expect(parseCapacity(' 256K ')).toBe(256_000)
    expect(parseCapacity('256k')).toBe(256_000)
    expect(parseCapacity('1M')).toBe(1_000_000)
    expect(parseCapacity('1m')).toBe(1_000_000)
    // 1M is 1000K, not 1024K: capacities are quoted in decimal.
    expect(parseCapacity('1M')).toBe(parseCapacity('1000K'))
    // 2.3 * 1e6 is a few ULPs high in binary floating point; an integral
    // intent must not become a fractional count the validator rejects.
    expect(parseCapacity('2.3M')).toBe(2_300_000)
    expect(Number.isInteger(parseCapacity('1.5M'))).toBe(true)
    // A genuinely fractional count survives as one, for the validator to reject.
    expect(parseCapacity('0.0001K')).toBeCloseTo(0.1)
    expect(parseCapacity('abc')).toBeNaN()
    expect(parseCapacity('1G')).toBeNaN()
    expect(parseCapacity('1M1')).toBeNaN()
  })

  it('spells a stored count in the shortest form that round-trips', () => {
    expect(formatCapacity(1_000_000)).toBe('1M')
    expect(formatCapacity(256_000)).toBe('256K')
    expect(formatCapacity(1_500_000)).toBe('1500K')
    expect(formatCapacity(131_072)).toBe('131072')
    // Values the validator will reject are shown as-is rather than dressed up.
    expect(formatCapacity(Number.NaN)).toBe('NaN')
    expect(formatCapacity(0)).toBe('0')
    for (const text of ['1M', '256K', '131072', '1500K']) {
      expect(formatCapacity(parseCapacity(text) as number)).toBe(text)
    }
  })

  it.each([
    ['the schema default', undefined],
    ['the composition entry', { models: [{ id: 'pinned-by-deployment' }] }],
  ])('restores %s the moment the override is dropped, not after a reload', async (_label, base) => {
    // The regression: reset read the EFFECTIVE value, which still carries the
    // stored override until the unset is applied — so the rows did not change
    // and the catalog only looked restored after reopening the card.
    const { face } = scriptedFace()
    const stored = { models: [{ id: 'user-only-model', name: 'User Only' }] }
    const overridden: SettingsNamespaceView = {
      ns: 'llm-deepseek',
      schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as JsonValue,
      value: { ...stored, defaultContextWindow: 1_000_000 },
      ...base === undefined ? {} : { base },
      user: stored,
      autoGenerate: true, applies: 'live',
      secrets: [],
      revision: 0,
    }
    const { ProviderEditor } = await import('../src/client/ProviderEditor.tsx')
    render(<ProviderEditor
      provider="deepseek-official"
      displayName="DeepSeek"
      namespace={overridden}
      schema={settingsSchema}
      settingsPath={[]}
      operations={operationsWith(face)}
      t={t}
      readOnly={false}
      onClose={() => {}}
    />)
    fireEvent.click(screen.getByText(en.customized))
    expect(screen.getByText(en.modelsCustomized)).toBeTruthy()
    expect(screen.getAllByLabelText(new RegExp(en.modelId)).map(input => (input as HTMLInputElement).value))
      .toEqual(['user-only-model'])

    fireEvent.click(screen.getByText(en.resetModels))

    expect(screen.getByText(en.modelsInherited)).toBeTruthy()
    expect(screen.getAllByLabelText(new RegExp(en.modelId)).map(input => (input as HTMLInputElement).value))
      .toEqual(base === undefined ? ['deepseek-v4-flash', 'deepseek-v4-pro'] : ['pinned-by-deployment'])
  })

  it('renders malformed draft fallbacks without inventing catalog values', () => {
    render(<DeepSeekModelsEditor
      models={[{}]}
      overridden={false}
      defaultContextWindow={undefined}
      defaultMaxTokens={undefined}
      t={t}
      disabled={true}
      onChange={vi.fn()}
      onReset={vi.fn()}
    />)
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`).value).toBe('')
    expandRow(1)
    expect(screen.getByLabelText<HTMLInputElement>(`${en.contextWindow} 1`).placeholder)
      .toBe(en.contextWindowPlaceholder)
    expect(screen.getByLabelText<HTMLInputElement>(`${en.maxTokens} 1`).placeholder)
      .toBe(en.maxTokensPlaceholder)
  })

  it('pins the deepseek placeholder and clears typed input back to inherited', async () => {
    const { face } = scriptedFace()
    const bare: SettingsNamespaceView = {
      ns: 'llm-deepseek',
      schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as JsonValue,
      value: {},
      autoGenerate: true, applies: 'live',
      secrets: [],
      revision: 0,
    }
    const { ProviderEditor } = await import('../src/client/ProviderEditor.tsx')
    render(<ProviderEditor
      provider="deepseek-official"
      displayName="DeepSeek"
      namespace={bare}
      schema={settingsSchema}
      settingsPath={[]}
      operations={operationsWith(face)}
      t={t}
      readOnly={false}
      onClose={() => {}}
    />)
    fireEvent.click(screen.getByText(en.customized))
    const baseURL = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    expect(baseURL.placeholder).toBe('https://api.deepseek.com/anthropic (Default to use DEEPSEEK_BASE_URL)')
    fireEvent.change(baseURL, { target: { value: 'https://x' } })
    expect(baseURL.value).toBe('https://x')
    fireEvent.change(baseURL, { target: { value: '' } })
    expect(baseURL.value).toBe('')
  })

  it('renders the card without the stored-key hint when the credential probe is refused', async () => {
    const { face } = scriptedFace()
    face.credentials.describe = vi.fn(() => Promise.resolve(remoteFail('no credential provider')))
    const controller = new ModelsSettingsStore(ctxWith(face), settingsSchema, new SettingsDescribeMirror(ctxWith(face)))
    await controller.load()
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      operations={operationsWith(face)}
      schema={settingsSchema}
      t={t}
      renderSlot={() => null}
    />)
    const key = await screen.findByLabelText<HTMLInputElement>(en.keyInput)
    expect(key.placeholder).toBe(en.keyPlaceholderFallback.replace('{hint}', 'DEEPSEEK_API_KEY'))
  })

  it('surfaces a refused credential write on the card', async () => {
    await mountFirstRun({
      set: vi.fn(() => Promise.resolve(remoteFail(
        'credentials-local: invalid document at /home/user/.dsh/.credentials.yaml: BAD_INDENT at line 3, column 1',
      ))),
    })
    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    fireEvent.change(key, { target: { value: 'sk-live' } })
    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText(/invalid document at \/home\/user\/\.dsh\/\.credentials\.yaml/)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('requires confirmation before removing a user-added provider', async () => {
    const { mutate, unset } = await mountSection()
    fireEvent.click(screen.getByRole('button', { name: openaiCopy(en.removeProvider) }))
    const dialog = screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) })
    expect(dialog.textContent).toContain(openaiCopy(en.deleteDescriptionWithCredential))
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: en.cancel }))
    expect(unset).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
    expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull()
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: openaiCopy(en.removeProvider) }))
    fireEvent.click(within(screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) }))
      .getByRole('button', { name: en.close }))
    expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull()
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: openaiCopy(en.removeProvider) }))
    fireEvent.click(within(screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) }))
      .getByRole('button', { name: openaiCopy(en.deleteConfirm) }))
    await waitFor(() => { expect(unset).toHaveBeenCalledWith('OPENAI_API_KEY') })
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(unset.mock.invocationCallOrder[0]).toBeLessThan(mutate.mock.invocationCallOrder[0] as number)
    expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull()
    expect(mutate.mock.calls[0]).toEqual([
      'llm-pi-ai',
      [{ op: 'unset', path: ['providers', 'openai'] }],
      undefined,
    ])
  })

  it('blocks duplicate deletion while the confirmed removal is pending', async () => {
    let resolveRemoval!: (response: { ok: true; value: SettingsNamespaceView }) => void
    const mutate = vi.fn(() => new Promise<{ ok: true; value: SettingsNamespaceView }>((resolve) => {
      resolveRemoval = resolve
    }))
    await mountSection({ mutate })
    fireEvent.click(screen.getByRole('button', { name: openaiCopy(en.removeProvider) }))
    const dialog = screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) })
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: openaiCopy(en.deleteConfirm) })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    expect(confirm.disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: en.cancel }).disabled).toBe(true)
    expect(within(dialog).getByRole('button', { name: openaiCopy(en.deleting) })).toBe(confirm)
    fireEvent.click(within(dialog).getByRole('button', { name: en.close }))
    expect(screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBe(dialog)
    expect(mutate).toHaveBeenCalledOnce()
    await act(async () => { resolveRemoval(remoteOk(wireNamespaces()[2]!)) })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull()
    })
  })

  it('renders the load failure with a retry control', async () => {
    const face = scriptedFace()
    face.face.llm.listProviders.mockResolvedValue(remoteFail('directory down', 'gateway/internal'))
    const controller = new ModelsSettingsStore(
      ctxWith(face.face), settingsSchema, new SettingsDescribeMirror(ctxWith(face.face)))
    await controller.load()
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      operations={operationsWith(face.face)}
      schema={settingsSchema}
      t={t}
      renderSlot={() => null}
    />)
    expect(screen.getByText(/directory down/)).toBeTruthy()
    fireEvent.click(screen.getByText(en.retry))
    await waitFor(() => { expect(screen.queryByText(/directory down/)).toBeNull() })
  })

  it('loads on first render of an idle controller', async () => {
    const { face } = scriptedFace()
    const controller = new ModelsSettingsStore(ctxWith(face), settingsSchema, new SettingsDescribeMirror(ctxWith(face)))
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      operations={operationsWith(face)}
      schema={settingsSchema}
      t={t}
      renderSlot={() => null}
    />)
    await screen.findByText('DeepSeek')
  })

  it('removes by unsetting the profile path, never by rebuilding the section', async () => {
    // The page only needs to name the profile path; rebuilding the section
    // would widen the write for no benefit.
    const { face, mutate, controller } = await mountSection()
    await removeProviderProfile(
      operationsWith(face),
      controller,
      { settingsNs: 'llm-plain', settingsPath: ['ghost-profile'] },
    )
    expect(mutate.mock.calls[0]).toEqual([
      'llm-plain',
      [{ op: 'unset', path: ['ghost-profile'] }],
      undefined,
    ])
  })

  it('keeps the snapshot untouched and reports the message when a removal write is refused', async () => {
    const { face, controller } = await mountSection({
      mutate: vi.fn(() => Promise.resolve(remoteFail('read-only', 'settings/rejected'))),
    })
    const before = controller.store.getSnapshot().rows
    const failure = await removeProviderProfile(
      operationsWith(face),
      controller,
      { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
    )
    expect(failure).toBe('read-only')
    expect(controller.store.getSnapshot().rows).toBe(before)
  })

  it('keeps a failed identified deletion recoverable in its confirmation dialog', async () => {
    const mutate = vi.fn()
      .mockResolvedValueOnce(remoteFail('the host refused', 'settings/rejected'))
      .mockResolvedValueOnce(remoteOk(wireNamespaces()[2]!))
    const { unset } = await mountSection({ mutate })
    fireEvent.click(screen.getByRole('button', { name: openaiCopy(en.removeProvider) }))
    const dialog = screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) })
    const confirm = within(dialog).getByRole('button', { name: openaiCopy(en.deleteConfirm) })
    fireEvent.click(confirm)
    await within(dialog).findByText('the host refused')
    expect(screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBe(dialog)
    expect(unset).toHaveBeenCalledOnce()
    expect(mutate).toHaveBeenCalledOnce()

    fireEvent.click(confirm)
    await waitFor(() => { expect(unset).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull()
    })
  })

  it('retains credentials that are not identified as page-managed', async () => {
    const { unset, mutate } = await mountSection()
    const target = { provider: 'zombie', displayName: 'zombie' }
    fireEvent.click(screen.getByRole('button', { name: providerCopy(en.removeProvider, target) }))
    const dialog = screen.getByRole('dialog', { name: providerCopy(en.deleteTitle, target) })
    expect(dialog.textContent).toContain(providerCopy(en.deleteDescription, target))
    fireEvent.click(within(dialog).getByRole('button', { name: providerCopy(en.deleteConfirm, target) }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    expect(unset).not.toHaveBeenCalled()
    expect(mutate.mock.calls[0]).toEqual([
      'llm-pi-ai',
      [{ op: 'unset', path: ['providers', 'zombie'] }],
      undefined,
    ])
  })

  it('does not remove provider settings when its managed credential removal is refused', async () => {
    const { face, controller, mutate } = await mountSection({
      unset: vi.fn(() => Promise.resolve(remoteFail('credential is read-only'))),
    })
    const failure = await removeProviderProfile(
      operationsWith(face),
      controller,
      {
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'openai'],
        credentialRef: 'OPENAI_API_KEY',
      },
    )
    expect(failure).toBe('credential is read-only')
    expect(mutate).not.toHaveBeenCalled()
  })

})

describe('apiKeyFailure', () => {
  it('treats a blank field as no failure — it means keep the stored key', () => {
    expect(apiKeyFailure('')).toBeUndefined()
  })

  it.each([
    ['a printable-ASCII key', 'sk-0123456789'],
    ['a padded key, which the caller trims', '  sk-abc  '],
    ['the printable-ASCII boundary characters', '!~'],
    ['a hyphenated key carrying an equals sign', 'sk-ABC=xyz'],
    ['an all-upper-case key ending in base64 padding', 'ABCD=='],
    ['an all-upper-case key ending in one padding character', 'MNOPQRST='],
  ])('accepts %s', (_label, draft) => {
    expect(apiKeyFailure(draft)).toBeUndefined()
  })

  it.each([
    ['spaces', '   '],
    ['a tab', '\t'],
  ])('fails a field holding only %s instead of silently dropping it', (_label, draft) => {
    expect(apiKeyFailure(draft)).toBe('keyBlank')
  })

  it.each([
    ['an emoji', 'sk-\u{1F600}'],
    ['CJK text', 'sk-你好'],
    ['full-width punctuation', 'sk-abc，'],
    ['an interior space', 'sk-abc def'],
    ['a C0 control character', 'sk-abc\x01'],
    ['a latin-1 character', 'sk-café'],
  ])('fails %s as illegal characters', (_label, draft) => {
    expect(apiKeyFailure(draft)).toBe('keyIllegalCharacters')
  })

  it.each([
    ['a pasted environment line', 'DEEPSEEK_API_KEY=sk-abc'],
    ['double quotes', '"sk-abc"'],
    ['single quotes', '\'sk-abc\''],
    ['backticks', '`sk-abc`'],
  ])('fails %s as a format failure', (_label, draft) => {
    expect(apiKeyFailure(draft)).toBe('keyIllegalCharacters')
  })

  it('needs a matching closing quote before it calls a value wrapped', () => {
    // A lone quote and an unbalanced one are legal printable ASCII, so the
    // heuristic leaves them alone rather than guessing at a paste error.
    expect(apiKeyFailure('"')).toBeUndefined()
    expect(apiKeyFailure('"a')).toBeUndefined()
  })
})

it.each(['file', 'env', 'project-env', 'user-env'] as const)('shows only the blank-input environment detection for source %s', (source) => {
  renderPiAiEditor('openai', piAiNamespaceWith('openai', { apiKeyEnv: 'OPENAI_API_KEY' }), {
    credential: { configured: true, source, writable: true },
  })
  const hint = en.keyFallbackDetected.replace('{hint}', 'OPENAI_API_KEY')
  const input = screen.getByLabelText<HTMLInputElement>(en.keyInput)
  expect(screen.queryByText(/^API key source:/)).toBeNull()
  if (source === 'file') expect(screen.queryByText(hint)).toBeNull()
  else expect(screen.getAllByText(hint)).toHaveLength(1)
  expect(input.value).toBe('')
  expect(input.placeholder)
    .toBe(source === 'file' ? en.keyPlaceholderSaved : en.keyPlaceholderFallback.replace('{hint}', 'OPENAI_API_KEY'))
  fireEvent.change(input, { target: { value: 'new-key' } })
  expect(screen.queryByText(hint)).toBeNull()
  expect(screen.queryByText(/^API key source:/)).toBeNull()
  expect(input.getAttribute('aria-describedby')).toBeNull()
  fireEvent.change(input, { target: { value: '' } })
  if (source === 'file') expect(screen.queryByText(hint)).toBeNull()
  else expect(screen.getAllByText(hint)).toHaveLength(1)
})

it.each([
  ['unconfigured', { apiKeyEnv: 'OPENAI_API_KEY' }, { configured: false, source: 'env', writable: true }],
  ['unknown source', { apiKeyEnv: 'OPENAI_API_KEY' }, { configured: true, source: 'oauth', writable: true }],
  ['native authentication', {}, { configured: true, source: 'file', writable: true }],
] as const)('does not guess a source for %s', (_label, profile, credential) => {
  renderPiAiEditor('openai', piAiNamespaceWith('openai', profile), { credential })
  expect(screen.queryByText(/^API key source:/)).toBeNull()
  expect(document.body.textContent).not.toMatch(/oauth/i)
})

it('keeps an OAuth-only provider on its native authentication path', () => {
  renderPiAiEditor('openai-codex', wireNamespaces().find(view => view.ns === 'llm-pi-ai')!, {
    nativeAuth: { env: [], oauth: true },
  })
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  expect(authHelpText()).toBeNull()
  expect(document.body.textContent).not.toMatch(/oauth/i)
})

it.each([
  ['anthropic', ['ANTHROPIC_API_KEY'], en.keyHelp.replace('{env}', 'ANTHROPIC_API_KEY')],
  ['openai', ['OPENAI_API_KEY'], en.keyHelp.replace('{env}', 'OPENAI_API_KEY')],
] as const)('opens authentication help for %s on click and dismisses it with Escape', (provider, env, text) => {
  renderPiAiEditor(provider, piAiNamespaceWith(provider, {}), {
    nativeAuth: { env: [...env], oauth: true },
  })
  const help = screen.getByLabelText(en.authHelp)
  fireEvent.click(help)
  const tooltip = screen.getByRole('tooltip')
  expect(tooltip.textContent).toBe(text)
  expect(help.getAttribute('aria-describedby')).toBe(tooltip.id)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it.each([
  ['an OAuth-only provider', 'openai-codex', 'CODEX_TOKEN', { env: [], oauth: true }],
  [
    'a provider with catalog variables and an OAuth sign-in', 'anthropic', 'TEAM_ANTHROPIC_KEY',
    { env: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], oauth: true },
  ],
] as const)('names the profile reference of %s instead of its native authentication', (_label, provider, ref, nativeAuth) => {
  renderPiAiEditor(provider, piAiNamespaceWith(provider, { apiKeyEnv: ref }), { nativeAuth })
  expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).placeholder)
    .toBe(en.keyPlaceholderFallback.replace('{hint}', ref))
  expect(authHelpText()).toBe(en.keyHelp.replace('{env}', ref))
  expect(document.body.textContent).not.toMatch(/oauth/i)
})

it.each([
  [
    'with an OAuth sign-in', 'anthropic',
    { env: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], oauth: true },
    'ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY',
  ],
  ['without an OAuth sign-in', 'minimax-cn', { env: ['MINIMAX_CN_API_KEY'], oauth: false }, 'MINIMAX_CN_API_KEY'],
] as const)('lists method-neutral fallbacks for a catalog route %s', (_label, provider, nativeAuth, refs) => {
  renderPiAiEditor(provider, piAiNamespaceWith(provider, {}), { nativeAuth })
  expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).placeholder)
    .toBe(en.keyPlaceholderFallback.replace('{hint}', nativeAuth.env[0]))
  expect(authHelpText()).toBe(en.keyHelp.replace('{env}', refs))
  expect(document.body.textContent).not.toMatch(/oauth/i)
})

it('shows the next method-neutral fallback without modifying native authentication metadata', () => {
  const nativeAuth = { env: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], oauth: true }
  renderPiAiEditor('anthropic', piAiNamespaceWith('anthropic', {}), { nativeAuth })
  expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).placeholder)
    .toBe(en.keyPlaceholderFallback.replace('{hint}', 'ANTHROPIC_API_KEY'))
  expect(authHelpText()).toBe(en.keyHelp.replace('{env}', 'ANTHROPIC_API_KEY'))
  expect(nativeAuth.env).toEqual(['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'])
  expect(document.body.textContent).not.toMatch(/oauth/i)
})

it('detects a hidden native credential without displaying its reference', () => {
  renderPiAiEditor('anthropic', piAiNamespaceWith('anthropic', {}), {
    nativeAuth: { env: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], oauth: true },
    credentialChecks: {
      ANTHROPIC_OAUTH_TOKEN: { configured: true, source: 'env', writable: true },
      ANTHROPIC_API_KEY: { configured: false, writable: true },
    },
  })
  expect(screen.queryByText(en.keyFallbackMissing.replace('{hint}', 'ANTHROPIC_API_KEY'))).toBeNull()
  expect(document.body.textContent).toContain('Env var detected.')
  expect(document.body.textContent).not.toMatch(/oauth/i)
})

it.each([
  ['cloudflare-ai-gateway', ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'], ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID']],
  ['cloudflare-workers-ai', ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID'], ['CLOUDFLARE_ACCOUNT_ID']],
  ['google-vertex', ['GOOGLE_CLOUD_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'], ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION']],
] as const)('does not report endpoint variables as detected credentials for %s', (provider, env, baseURLEnv) => {
  renderPiAiEditor(provider, piAiNamespaceWith(provider, {}), {
    nativeAuth: { env, oauth: false },
    baseURLEnv,
    credentialChecks: Object.fromEntries(env.map(ref => [ref, {
      configured: baseURLEnv.some(name => name === ref), source: 'env', writable: true,
    }])),
  })
  expect(screen.getByText(en.keyFallbackMissing.replace('{hint}', env[0]))).toBeTruthy()
  expect(authHelpText()).toBe(en.keyHelp.replace('{env}', env[0]))
  expect(screen.queryByText(/Env var detected/)).toBeNull()
})

it('keeps a method-specific profile reference usable without displaying its name', () => {
  renderPiAiEditor('anthropic', piAiNamespaceWith('anthropic', { apiKeyEnv: 'TEAM_OAUTH_TOKEN' }), {
    nativeAuth: { env: ['ANTHROPIC_API_KEY'], oauth: true },
  })
  expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).placeholder).toBe(en.keyPlaceholder)
  expect(authHelpText()).toBeNull()
  expect(document.body.textContent).not.toMatch(/oauth/i)
})

it('offers a plain key field to a route the adapter reports no authentication or endpoint for', () => {
  renderPiAiEditor('zombie', wireNamespaces().find(view => view.ns === 'llm-pi-ai')!)
  expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).placeholder).toBe(en.keyPlaceholder)
  expect(authHelpText()).toBeNull()
  fireEvent.click(screen.getByText(en.customized))
  expect(screen.getByLabelText<HTMLInputElement>(en.baseUrl).placeholder).toBe(en.baseUrlDefault)
})

it('shows endpoint configuration variables without presenting them as credential keys', () => {
  const baseURLEnv = ['AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME']
  renderPiAiEditor('azure', wireNamespaces().find(view => view.ns === 'llm-pi-ai')!, {
    baseURLEnv, nativeAuth: { env: ['AZURE_OPENAI_API_KEY'], oauth: false },
  })
  expect(authHelpText()).toContain('AZURE_OPENAI_API_KEY')
  expect(authHelpText()).not.toContain('AZURE_OPENAI_BASE_URL')
  fireEvent.click(screen.getByText(en.customized))
  const input = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
  expect(input.placeholder).toBe(en.baseUrlConfigured)
  expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent)
    .toBe(en.baseUrlEnvironment.replace('{env}', baseURLEnv.join(', ')))
})

it.each([true, false, undefined])('shows the confirmed fallback state without assuming a connection works: %s', (configured) => {
  renderPiAiEditor('deepseek', wireNamespaces().find(view => view.ns === 'llm-pi-ai')!, {
    nativeAuth: { env: ['DEEPSEEK_API_KEY'], oauth: false },
    ...configured === undefined ? {} : { credentialChecks: { DEEPSEEK_API_KEY: { configured, writable: true } } },
  })
  const input = screen.getByLabelText<HTMLInputElement>(en.keyInput)
  expect(input.placeholder).toBe(en.keyPlaceholderFallback.replace('{hint}', 'DEEPSEEK_API_KEY'))
  const hint = configured === true ? en.keyFallbackDetected.replace('{hint}', 'DEEPSEEK_API_KEY')
    : configured === false ? en.keyFallbackMissing.replace('{hint}', 'DEEPSEEK_API_KEY') : en.keyFallbackUnchecked
  expect(screen.getByText(hint).getAttribute('role')).toBeNull()
  expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe(hint)
  fireEvent.change(input, { target: { value: 'new-key' } })
  expect(screen.queryByText(hint)).toBeNull()
  expect(input.getAttribute('aria-describedby')).toBeNull()
})

it('checks all native fallback names and displays a later configured source', () => {
  renderPiAiEditor('anthropic', wireNamespaces().find(view => view.ns === 'llm-pi-ai')!, {
    nativeAuth: { env: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], oauth: true },
    credentialChecks: {
      ANTHROPIC_AUTH_TOKEN: { configured: false, writable: true },
      ANTHROPIC_OAUTH_TOKEN: { configured: true, writable: true },
      ANTHROPIC_API_KEY: { configured: true, source: 'env', writable: true },
    },
  })
  expect(screen.getByText(en.keyFallbackDetectedHidden)).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/oauth/i)
})

it('keeps an inherited profile endpoint ahead of dynamic provider configuration', () => {
  const namespace = wireNamespaces().find(view => view.ns === 'llm-pi-ai')!
  renderPiAiEditor('azure', { ...namespace, value: { providers: { azure: { baseURL: 'https://team.example/openai/v1' } } } }, {
    baseURLEnv: ['AZURE_OPENAI_BASE_URL'],
  })
  fireEvent.click(screen.getByText(en.customized))
  const input = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
  expect(input.placeholder).toBe('https://team.example/openai/v1')
  expect(input.getAttribute('aria-describedby')).toBeNull()
})

it('renders the localized account row as signed in without an edit action', async () => {
  const scripted = scriptedFace({})
  const { controller } = await mountFace(scripted)
  const row = controller.store.getSnapshot().rows[0]!
  await act(async () => { controller.store.update((state) => {
    state.rows = [{ ...row, accountAvailable: true, entry: { ...row.entry, provider: 'deepseek-account' } }]
  }) })
  const item = screen.getByText(en.deepSeekAccount).closest('li')!
  expect(within(item).getByText(en.accountSignedIn)).toBeTruthy()
  expect(within(item).queryByText(en.edit)).toBeNull()
})
