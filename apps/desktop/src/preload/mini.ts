import { contextBridge, ipcRenderer } from 'electron';
import type { MiniTavernApi } from '@shared/ipc';
import type { WatchDecision, WatchSnapshot } from '@shared/watch';

/**
 * This preload is a second rollup entry beside index.ts, and a sandboxed preload cannot load a
 * shared chunk. So it imports nothing at runtime but electron, and spells its channels out;
 * mini.test.ts holds them equal to IPC_CHANNELS.
 */
export const MINI_CHANNELS = {
  watchGetSnapshot: 'watch:get-snapshot',
  watchSnapshot: 'watch:snapshot',
  watchRespond: 'watch:respond',
  watchFocusAgent: 'watch:focus-agent',
  watchCloseMini: 'watch:close-mini',
} as const;

// The mini Tavern's whole bridge: see MiniTavernApi for why it is this small. Main also checks
// that each of these calls comes from the mini window itself (main/watch/ipc.ts).
const api: MiniTavernApi = {
  getSnapshot: () => ipcRenderer.invoke(MINI_CHANNELS.watchGetSnapshot),
  onSnapshot: listener => {
    const handler = (_event: unknown, snapshot: WatchSnapshot) => listener(snapshot);
    ipcRenderer.on(MINI_CHANNELS.watchSnapshot, handler);
    return () => ipcRenderer.removeListener(MINI_CHANNELS.watchSnapshot, handler);
  },
  respond: (approvalId: string, decision: WatchDecision) =>
    ipcRenderer.invoke(MINI_CHANNELS.watchRespond, approvalId, decision),
  focusAgent: (sessionId: string, rootId: string) =>
    ipcRenderer.invoke(MINI_CHANNELS.watchFocusAgent, sessionId, rootId),
  close: () => ipcRenderer.invoke(MINI_CHANNELS.watchCloseMini),
};

// Key must stay in sync with the Window declaration in src/preload/index.d.ts.
contextBridge.exposeInMainWorld('b4mMini', api);
