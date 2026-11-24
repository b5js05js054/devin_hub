/**
 * Prompts for and installs the client release the card-auth backend publishes.
 * A package without an updater feed has no other update source, so this flow also answers
 * the user's own "check for updates" request there.
 */

import { formatDesktopMessage, type DesktopMessages } from './locale.ts'
import { isNewerRelease, type RelayUpdate, type RelayUpdateLookup } from './relay-update.ts'
import type { UpdateDialogOptions } from './update-dialog.ts'

/** Native effects of the flow, replaceable at the test boundary. */
export interface RelayUpdateFlowHost {
  /** @returns the backend's answer; rejects while the workspace service cannot be asked. */
  lookup(): Promise<RelayUpdateLookup>
  /** @returns the installed application version. */
  installedVersion(): string
  /** @returns copy in the current shell language, read again for every prompt. */
  messages(): DesktopMessages
  /**
   * @param options - main-owned prompt content and choices.
   * @returns the selected button index; a dismissed prompt answers its cancel index.
   */
  show(options: UpdateDialogOptions): Promise<{ readonly response: number }>
  /**
   * Show a notice while work is in flight; the user may dismiss it, which cancels nothing.
   * @param options - main-owned notice content.
   * @returns closes the notice when it is still open.
   */
  notice(options: UpdateDialogOptions): () => Promise<void>
  /**
   * @param update - release to fetch.
   * @returns absolute path of the downloaded package, checksum verified when one is published.
   */
  download(update: RelayUpdate): Promise<string>
  /**
   * Start the downloaded installer and leave the application.
   * @param file - verified package path.
   * @returns after the installer was started; rejects when it cannot be started.
   */
  install(file: string): Promise<void>
}

/** Decision of one lookup against the installed version. */
type Outcome =
  | { readonly kind: 'available'; readonly update: RelayUpdate }
  | { readonly kind: 'current' }
  | { readonly kind: 'failed'; readonly summary: string; readonly technicalDetails: string }

/** One backend release lookup at a time, with the prompts that follow from it. */
export class DesktopRelayUpdateFlow {
  private operation: Promise<void> | undefined
  /** A user is waiting on the running check, so it must end in a visible answer. */
  private answerRequired = false
  /** Optional release the user postponed; automatic checks stay quiet about it for this run. */
  private declined: string | undefined

  /** @param host - native prompts, download, and installer handoff. */
  constructor(private readonly host: RelayUpdateFlowHost) {}

  /**
   * Look up the published release, joining a lookup already in flight.
   * @param manual - whether the user asked. A manual check always ends in an answer: a newer
   * release, "up to date", or why the backend could not be asked. An automatic check prompts
   * only for a newer release the user has not postponed.
   * @returns after every prompt of this check closed; never rejects.
   */
  check(manual = false): Promise<void> {
    if (manual) this.answerRequired = true
    this.operation ??= this.run()
      .catch((error: unknown) => { console.error(error) })
      .finally(() => {
        this.operation = undefined
        this.answerRequired = false
      })
    return this.operation
  }

  private async run(): Promise<void> {
    const outcome = await this.decide()
    const messages = this.host.messages()
    if (outcome.kind === 'failed') {
      if (this.answerRequired) {
        await this.host.show({ type: 'error', title: messages.updateFailedTitle, message: outcome.summary, technicalDetails: outcome.technicalDetails })
      }
      return
    }
    if (outcome.kind === 'current') {
      if (this.answerRequired) {
        await this.host.show({ type: 'info', title: messages.updateCheckTitle, message: messages.updateCurrent,
          detail: formatDesktopMessage(messages.updateCurrentDetail, { version: this.host.installedVersion() }) })
      }
      return
    }
    const { update } = outcome
    if (!update.mandatory && !this.answerRequired && this.declined === update.version) return
    // A mandatory release offers no way out: its only button is also the dismissal answer.
    const answer = await this.host.show({
      type: 'info', title: messages.relayUpdateTitle,
      message: formatDesktopMessage(update.mandatory ? messages.relayUpdateRequired : messages.relayUpdateAvailable, { version: update.version }),
      detail: update.note,
      buttons: update.mandatory ? [messages.relayUpdateInstall] : [messages.relayUpdateInstall, messages.later],
      cancelId: update.mandatory ? 0 : 1,
    })
    if (answer.response !== 0) {
      this.declined = update.version
      return
    }
    await this.install(update, messages)
  }

  /** Ask the backend behind a checking notice when a user is waiting; a rejected lookup is a failed check. */
  private async decide(): Promise<Outcome> {
    const messages = this.host.messages()
    const close = this.answerRequired
      ? this.host.notice({ type: 'info', title: messages.updateCheckTitle, message: messages.updateChecking, buttons: [messages.later], cancelId: 0 })
      : undefined
    let lookup: RelayUpdateLookup
    try {
      lookup = await this.host.lookup()
    } catch (error) {
      return { kind: 'failed', summary: messages.updateCheckFailed, technicalDetails: error instanceof Error ? error.message : String(error) }
    } finally {
      await close?.()
    }
    if (!lookup.ok) {
      const { code, message } = lookup
      const summary = code === 'signed-out' || code === 'unauthorized' ? messages.updateCheckSignedOut
        : code === 'network' ? messages.updateCheckNetworkFailed : messages.updateCheckFailed
      // The Host repeats the failure class as the message when the backend supplied no text.
      const reason = message === '' || message === code ? '' : `: ${message}`
      return { kind: 'failed', summary, technicalDetails: `desktop update: backend release lookup failed (${code})${reason}` }
    }
    return lookup.update !== null && isNewerRelease(lookup.update.version, this.host.installedVersion())
      ? { kind: 'available', update: lookup.update } : { kind: 'current' }
  }

  /** Download behind a notice, then hand over to the installer; a failure is reported and the application keeps running. */
  private async install(update: RelayUpdate, messages: DesktopMessages): Promise<void> {
    const close = this.host.notice({ type: 'info', title: messages.relayUpdateTitle, message: messages.relayUpdateDownloading,
      detail: messages.relayUpdateDownloadingDetail, buttons: [messages.updateClose], cancelId: 0 })
    let failure: string | undefined
    try {
      await this.host.install(await this.host.download(update))
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    } finally {
      await close()
    }
    if (failure === undefined) return
    await this.host.show({ type: 'error', title: messages.relayUpdateTitle, message: messages.relayUpdateDownloadFailed,
      detail: failure, buttons: [messages.later], cancelId: 0 })
  }
}
