import type { DesktopApi } from '../shared/ipc';

declare global {
  interface Window {
    b4m: DesktopApi;
  }
}
