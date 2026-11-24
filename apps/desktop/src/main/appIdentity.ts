import { isAbsolute, join } from 'node:path';

/**
 * The name a dev run (`pnpm dev`) takes instead of the packaged app's. Electron derives the
 * userData folder and, on macOS, the safeStorage keychain item ("<name> Safe Storage") from the
 * app name, so a dev run under the packaged name would share - and fight over - the installed
 * app's refresh token, sessions and every preference.
 */
export const DEV_APP_NAME = 'Bike4Mind Dev';

/**
 * Dev-only: an absolute folder to use as userData instead of the shared dev profile, so a second
 * dev run (a throwaway profile for screenshots, say) cannot touch the one another session drives.
 * Ignored by packaged builds.
 */
export const DEV_USER_DATA_ENV = 'B4M_DESKTOP_DEV_USER_DATA';

type AppIdentityHost = {
  readonly isPackaged: boolean;
  getPath(name: 'appData'): string;
  setName(name: string): void;
  setPath(name: 'userData', path: string): void;
};

/**
 * Move a dev run onto its own name and userData folder. Packaged builds are left alone on
 * purpose: they have always lived under package.json's `name` (@bike4mind/desktop), and renaming
 * them would orphan every existing install's vault and keychain item, signing everyone out.
 *
 * Must run before anything reads userData or touches safeStorage, which is why index.ts imports
 * this module ahead of everything else.
 */
export function applyAppIdentity(host: AppIdentityHost, env: NodeJS.ProcessEnv = process.env): void {
  if (host.isPackaged) return;
  host.setName(DEV_APP_NAME);
  const override = env[DEV_USER_DATA_ENV]?.trim();
  // Explicit rather than relying on setName: userData is resolved lazily from the name, and
  // anything that read it first would have pinned the shared folder.
  host.setPath('userData', override && isAbsolute(override) ? override : join(host.getPath('appData'), DEV_APP_NAME));
}
