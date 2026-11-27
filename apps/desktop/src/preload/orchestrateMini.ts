import { contextBridge, ipcRenderer } from 'electron';
import type { OrchestrateMiniApi } from '@shared/ipc';

/**
 * A third rollup entry beside index.ts and mini.ts, and a sandboxed preload cannot load a shared
 * chunk. So it imports nothing at runtime but electron, and spells its channels out;
 * bridges.test.ts holds them equal to IPC_CHANNELS.
 */
export const ORCHESTRATE_MINI_CHANNELS = {
  orchestrateMiniGetSnapshot: 'orchestrate:mini-get-snapshot',
  orchestrateMiniSnapshot: 'orchestrate:mini-snapshot',
  orchestrateMiniFocus: 'orchestrate:mini-focus',
  orchestrateMiniClose: 'orchestrate:mini-close',
} as const;

// The Orchestrate mini window's whole bridge: see OrchestrateMiniApi for why it is this small. Main
// also checks that each of these calls comes from that window itself (main/orchestrateMini/ipc.ts).
const api: OrchestrateMiniApi = {
  getSnapshot: () => ipcRenderer.invoke(ORCHESTRATE_MINI_CHANNELS.orchestrateMiniGetSnapshot),
  onSnapshot: listener => {
    const handler = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(ORCHESTRATE_MINI_CHANNELS.orchestrateMiniSnapshot, handler);
    return () => ipcRenderer.removeListener(ORCHESTRATE_MINI_CHANNELS.orchestrateMiniSnapshot, handler);
  },
  focus: (agentId: string) => ipcRenderer.invoke(ORCHESTRATE_MINI_CHANNELS.orchestrateMiniFocus, agentId),
  close: () => ipcRenderer.invoke(ORCHESTRATE_MINI_CHANNELS.orchestrateMiniClose),
};

// Key must stay in sync with the Window declaration in src/preload/index.d.ts.
contextBridge.exposeInMainWorld('b4mOrchestrateMini', api);
