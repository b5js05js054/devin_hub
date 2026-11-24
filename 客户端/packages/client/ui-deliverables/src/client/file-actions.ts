/** Native file-action contribution shared by delivery cards and change review. */
import type { PresentedOpenFailure } from './present-open.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PresentedAction } from '../presented.ts'
import type { ChangesDiff } from '../changes.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Open one file through its authorized Session event coordinates. */
    'deliverables.file.actions': {
      kind: 'list'
      scope: 'session'
      owner: {
        /** Authenticated document-relative action route carrying Session event coordinates. */
        readonly actionUrl: string
        readonly available: boolean
        readonly pending: boolean
        /** Execute the selected native action and publish status on the owning file surface. */
        readonly onAction: (action: PresentedAction, application?: string) => Promise<PresentedOpenFailure>
      }
    }
    /** Whole-turn actions on the changed-files card header. */
    'deliverables.changes.actions': {
      kind: 'list'
      scope: 'session'
      owner: {
        readonly sessionId: SessionId
        /** Sequence of the event announcing the turn's summary; identifies the turn. */
        readonly seq: number
        readonly files: readonly { readonly path: string; readonly display: string }[]
        /** The turn-start and turn-end comparison of the file at a summary index; undefined when the Host cannot serve it. */
        readonly readDiff: (index: number) => Promise<ChangesDiff | undefined>
      }
    }
    /** The same file actions owned by a changed-file review tab. */
    'deliverables.review.file.actions': {
      kind: 'list'
      scope: 'session'
      owner: SlotMap['deliverables.file.actions']['owner']
    }
  }
}
