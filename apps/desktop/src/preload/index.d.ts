import type { DesktopApi, MiniTavernApi } from '../shared/ipc';

declare global {
  interface Window {
    b4m: DesktopApi;
    /** Only in the mini Tavern window (preload/mini.ts); absent everywhere else. */
    b4mMini?: MiniTavernApi;
  }
}
