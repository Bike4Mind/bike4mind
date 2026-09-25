/**
 * IPC contract shared by the main process and the preload bridge.
 *
 * Invariant for every channel added here: secrets stay in main. The OAuth device flow
 * lands in the main process in a later task so that tokens never enter the renderer,
 * so a channel may return auth STATE (signed in, which account, when it expires) but
 * never an access token, refresh token, or raw cookie.
 */
export const IPC_CHANNELS = {
  getAppInfo: 'app:get-info',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export interface AppInfo {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
}

/** The whole surface exposed on `window.b4m`. Mirrored in src/preload/index.d.ts. */
export interface DesktopApi {
  getAppInfo(): Promise<AppInfo>;
}
