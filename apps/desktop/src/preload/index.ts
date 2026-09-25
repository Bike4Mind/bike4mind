import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type DesktopApi } from '../shared/ipc';

// Written out one method per channel rather than a generic invoke(channel, ...args)
// passthrough: a passthrough would let renderer code reach every handler main ever
// registers, which defeats the point of keeping the auth handlers out of its reach.
const api: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
};

// Key must stay in sync with the Window declaration in src/preload/index.d.ts.
contextBridge.exposeInMainWorld('b4m', api);
