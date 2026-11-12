import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type MiniTavernApi } from '@shared/ipc';
import type { WatchDecision, WatchSnapshot } from '@shared/watch';

// The mini Tavern's whole bridge: see MiniTavernApi for why it is this small. Main also checks
// that each of these calls comes from the mini window itself (main/watch/ipc.ts).
const api: MiniTavernApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.watchGetSnapshot),
  onSnapshot: listener => {
    const handler = (_event: unknown, snapshot: WatchSnapshot) => listener(snapshot);
    ipcRenderer.on(IPC_CHANNELS.watchSnapshot, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.watchSnapshot, handler);
  },
  respond: (approvalId: string, decision: WatchDecision) =>
    ipcRenderer.invoke(IPC_CHANNELS.watchRespond, approvalId, decision),
  focusAgent: (sessionId: string, rootId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.watchFocusAgent, sessionId, rootId),
  close: () => ipcRenderer.invoke(IPC_CHANNELS.watchCloseMini),
};

// Key must stay in sync with the Window declaration in src/preload/index.d.ts.
contextBridge.exposeInMainWorld('b4mMini', api);
