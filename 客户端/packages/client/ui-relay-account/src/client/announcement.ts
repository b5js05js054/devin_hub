/**
 * The announcement the relay operator publishes, as this page shows it.
 *
 * One watcher asks the Host for it while a relay account is signed in and the
 * page is visible: at once when either becomes true, then again a fixed pause
 * after each answer. It keeps what it last learned through a failed check, and
 * hides an announcement the user dismissed until the operator publishes a
 * different one.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RelayAnnouncement, RelayAnnouncementResult, RelayView } from '@deepseek-ai/dsh-api-remotes/client'

/** Pause between an answer and the next check. */
export const ANNOUNCEMENT_INTERVAL_MS = 5_000

const DISMISSED_KEY = 'dsh.relay.announcement.dismissed.v1'

/** Whether the page can be seen, and when that changes. */
export interface AnnouncementVisibility {
  readonly visible: () => boolean
  /** @returns the function that stops the notifications. */
  readonly subscribe: (listener: () => void) => () => void
}

/** The dismissed announcement, kept beyond this page's lifetime. */
export interface AnnouncementMemory {
  /** @returns the identity of the dismissed announcement, or null when none is dismissed. */
  readonly read: () => string | null
  readonly write: (signature: string | null) => void
}

/** What a watcher needs from its surroundings. */
export interface AnnouncementWatcherOptions {
  /** Ask the Host for the published announcement; a rejection counts as a failed check. */
  readonly load: () => Promise<RelayAnnouncementResult>
  readonly visibility: AnnouncementVisibility
  readonly memory: AnnouncementMemory
}

/** The shown announcement with the actions that change it. */
export interface AnnouncementWatcher {
  /** The announcement on display, or null while none shows. */
  readonly hooks: { readonly announcement: HostObservable<RelayAnnouncement | null> }
  /**
   * Follow the signed-in relay session. A session not seen before is checked at
   * once; no session stops the checks and hides the announcement.
   * @param session - identity of the signed-in session, undefined while signed out.
   */
  readonly follow: (session: string | undefined) => void
  /** Hide the shown announcement until the operator publishes a different one. */
  readonly dismiss: () => void
  /** Stop checking for good. */
  readonly dispose: () => void
}

/**
 * Name the signed-in session of a relay snapshot, so that a new sign-in is told from a repeated report of the same one.
 * @param view - latest relay snapshot, undefined before the first one arrives.
 * @returns the session identity, or undefined while no account is signed in.
 */
export function announcementSession(view: RelayView | undefined): string | undefined {
  const account = view?.account
  if (account?.status !== 'signed-in' || account.profile === null) return undefined
  return `${String(account.profile.id)}|${String(account.expiresAt)}`
}

/**
 * Read the page's own visibility: a minimized or fully covered window counts as hidden.
 * @returns the visibility of this document and its change notifications.
 */
export function pageVisibility(): AnnouncementVisibility {
  return {
    visible: () => document.visibilityState !== 'hidden',
    subscribe: (listener) => {
      document.addEventListener('visibilitychange', listener)
      return () => { document.removeEventListener('visibilitychange', listener) }
    },
  }
}

/**
 * Keep the dismissed announcement in the browser's local store; an unavailable store only loses the memory across restarts.
 * @returns the browser-local record of the dismissed announcement.
 */
export function rememberedDismissal(): AnnouncementMemory {
  return {
    read: () => {
      try {
        return localStorage.getItem(DISMISSED_KEY)
      } catch {
        return null
      }
    },
    write: (signature) => {
      try {
        if (signature === null) localStorage.removeItem(DISMISSED_KEY)
        else localStorage.setItem(DISMISSED_KEY, signature)
      } catch {
        // A private or full browser store costs only the memory across restarts.
      }
    },
  }
}

/** Two announcements with one signature read the same to the user. */
function signatureOf(announcement: RelayAnnouncement): string {
  return `${announcement.level}\n${announcement.title}\n${announcement.content}`
}

/**
 * Create the watcher behind the announcement banner.
 * @param options - the Host lookup, page visibility, and dismissal memory.
 * @returns the observable announcement with its session, dismissal, and disposal actions.
 */
export function createAnnouncementWatcher(options: AnnouncementWatcherOptions): AnnouncementWatcher {
  let shown: RelayAnnouncement | null = null
  let dismissed = options.memory.read()
  let session: string | undefined
  // Set when the Host reports the session unusable: asking again would only repeat the refusal.
  let refused = false
  // Counts session changes, so an answer is matched to the session that asked for it.
  let generation = 0
  let checking = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()

  const publish = (next: RelayAnnouncement | null): void => {
    if (next === shown || (next !== null && shown !== null && signatureOf(next) === signatureOf(shown))) return
    shown = next
    for (const listener of [...listeners]) listener()
  }
  const wanted = (): boolean => !disposed && session !== undefined && !refused && options.visibility.visible()
  const cancel = (): void => {
    clearTimeout(timer)
    timer = undefined
  }

  const accept = (result: RelayAnnouncementResult): void => {
    if (!result.ok) {
      if (result.code !== 'signed-out' && result.code !== 'unauthorized') return
      refused = true
      publish(null)
      return
    }
    if (result.announcement === null) {
      // Withdrawn: the same text published again is a new announcement to the user.
      if (dismissed !== null) {
        dismissed = null
        options.memory.write(null)
      }
      publish(null)
      return
    }
    publish(signatureOf(result.announcement) === dismissed ? null : result.announcement)
  }

  const check = async (): Promise<void> => {
    if (checking || !wanted()) return
    cancel()
    checking = true
    const asked = generation
    // A rejection means the Host connection dropped; the next check asks again.
    const result = await options.load().catch(() => undefined)
    checking = false
    if (asked !== generation) {
      // The session changed meanwhile; its own first check was held back by this one.
      void check()
      return
    }
    if (result !== undefined) accept(result)
    if (wanted()) timer = setTimeout(() => { void check() }, ANNOUNCEMENT_INTERVAL_MS)
  }

  const unwatch = options.visibility.subscribe(() => {
    if (options.visibility.visible()) void check()
    else cancel()
  })

  return {
    hooks: {
      announcement: {
        getSnapshot: () => shown,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    },
    follow: (next) => {
      if (disposed || next === session) return
      session = next
      refused = false
      generation += 1
      cancel()
      if (next === undefined) publish(null)
      else void check()
    },
    dismiss: () => {
      if (shown === null) return
      dismissed = signatureOf(shown)
      options.memory.write(dismissed)
      publish(null)
    },
    dispose: () => {
      disposed = true
      generation += 1
      cancel()
      unwatch()
    },
  }
}
