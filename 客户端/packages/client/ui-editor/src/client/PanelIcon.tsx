import type { ReactNode } from 'react'
import { IconCodeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the IDE glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share.
 * @returns the icon element.
 */
export function IdePanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconCodeOutlineRegular size={size} />
}
