/** Media generation Remote values carry no license token. */

/** One adjustable parameter of a media model, as advertised by the relay. */
export interface MediaField {
  readonly key: string
  readonly label: string
  readonly type: 'select' | 'number'
  readonly options?: readonly string[] | undefined
  readonly min?: number | undefined
  readonly max?: number | undefined
  readonly default: string | number | null
  readonly required: boolean
}

/** Adjustable parameters of one media model. */
export interface MediaSpec {
  readonly kind: 'image' | 'video'
  /** Whether the relay confirmed the fields with the upstream or used built-in defaults. */
  readonly source: 'upstream' | 'builtin'
  readonly fields: readonly MediaField[]
}

/** Result of a spec lookup; failures are values so the panel can hide itself or show a note. */
export type MediaSpecResult =
  | { readonly ok: true; readonly spec: MediaSpec }
  | { readonly ok: false; readonly code: 'not-media' | 'not-activated' | 'unavailable'; readonly message: string }

/** User-chosen parameter values keyed by {@link MediaField.key}. */
export type MediaParams = Readonly<Record<string, string | number>>
