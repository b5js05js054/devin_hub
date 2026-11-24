/** Localized welcome copy and relay sign-in actions. */

import { contextBridge, ipcRenderer } from 'electron'
import { resolveDesktopLocale } from './locale.ts'
import { WELCOME_IPC, type RelayWelcomeActivation, type RelayWelcomeState, type WelcomeApi } from './welcome-api.ts'

const prefix = '--dsh-welcome-locale='
const locale = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
if (locale === undefined) throw new Error('desktop welcome: missing window locale')
const api: WelcomeApi = {
  ...resolveDesktopLocale(locale),
  analytics: async (eventName, attributes) => {
    if (await api.analyticsEnabled()) await ipcRenderer.invoke(WELCOME_IPC.analytics, eventName, attributes)
  },
  analyticsEnabled: () => ipcRenderer.invoke(WELCOME_IPC.analyticsEnabled) as Promise<boolean>,
  startSignIn: () => ipcRenderer.invoke(WELCOME_IPC.start) as Promise<RelayWelcomeState>,
  cancelSignIn: () => ipcRenderer.invoke(WELCOME_IPC.cancel) as Promise<RelayWelcomeState>,
  copySignInLink: () => ipcRenderer.invoke(WELCOME_IPC.copyLink) as Promise<void>,
  readRelay: () => ipcRenderer.invoke(WELCOME_IPC.read) as Promise<RelayWelcomeState>,
  activate: (cardKey: string) => ipcRenderer.invoke(WELCOME_IPC.activate, cardKey) as Promise<RelayWelcomeActivation>,
  signOut: () => ipcRenderer.invoke(WELCOME_IPC.signOut) as Promise<RelayWelcomeState>,
  onRelayState: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, state: RelayWelcomeState): void => { listener(state) }
    ipcRenderer.on(WELCOME_IPC.state, receive)
    return () => { ipcRenderer.removeListener(WELCOME_IPC.state, receive) }
  },
}
contextBridge.exposeInMainWorld('dshWelcome', api)
