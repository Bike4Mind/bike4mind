import type { DesktopApi, MiniTavernApi, OrchestrateMiniApi } from '../shared/ipc';

declare global {
  interface Window {
    b4m: DesktopApi;
    /** Only in the mini Tavern window (preload/mini.ts); absent everywhere else. */
    b4mMini?: MiniTavernApi;
    /** Only in the Orchestrate mini window (preload/orchestrateMini.ts); absent everywhere else. */
    b4mOrchestrateMini?: OrchestrateMiniApi;
  }
}
