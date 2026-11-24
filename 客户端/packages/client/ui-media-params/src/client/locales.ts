/** Media parameter panel copy, owned by the media parameter feature. */

/** English dictionary. */
export const en = {
  open: 'Generation settings',
  title: 'Generation settings',
  unconfirmed: 'These options were not confirmed by the upstream; defaults may be rejected.',
  loadFailed: 'Could not load the options for this model.',
  retry: 'Retry',
  loading: 'Loading…',
} as const

/** Key of the media parameter dictionary. */
export type MediaParamsKey = keyof typeof en

/** Chinese dictionary. */
export const zh: Record<MediaParamsKey, string> = {
  open: '生成参数',
  title: '生成参数',
  unconfirmed: '这些选项未经上游确认,默认值可能被拒绝。',
  loadFailed: '无法加载该模型的可选参数。',
  retry: '重试',
  loading: '加载中…',
}
