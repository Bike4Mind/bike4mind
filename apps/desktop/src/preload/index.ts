import { contextBridge, ipcRenderer } from 'electron';
import type { AccountPage, AuthState, EnvironmentSelection } from '@shared/auth';
import { IPC_CHANNELS, type DesktopApi } from '@shared/ipc';

// Written out one method per channel rather than a generic invoke(channel, ...args)
// passthrough: a passthrough would let renderer code reach every handler main ever
// registers, which defeats the point of keeping the auth handlers out of its reach.
const api: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  auth: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.authGetState),
    signIn: () => ipcRenderer.invoke(IPC_CHANNELS.authSignIn),
    cancelSignIn: () => ipcRenderer.invoke(IPC_CHANNELS.authCancelSignIn),
    signOut: () => ipcRenderer.invoke(IPC_CHANNELS.authSignOut),
    setEnvironment: (selection: EnvironmentSelection) => ipcRenderer.invoke(IPC_CHANNELS.authSetEnvironment, selection),
    retryIdentity: () => ipcRenderer.invoke(IPC_CHANNELS.authRetryIdentity),
    openAccountPage: (page: AccountPage) => ipcRenderer.invoke(IPC_CHANNELS.authOpenAccountPage, page),
    onStateChanged: listener => {
      // The raw IpcRendererEvent carries a `sender` handle; forwarding only the payload keeps
      // renderer code from reaching back into main through it.
      const handler = (_event: unknown, state: AuthState) => listener(state);
      ipcRenderer.on(IPC_CHANNELS.authStateChanged, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.authStateChanged, handler);
    },
  },
};

// Key must stay in sync with the Window declaration in src/preload/index.d.ts.
contextBridge.exposeInMainWorld('b4m', api);
