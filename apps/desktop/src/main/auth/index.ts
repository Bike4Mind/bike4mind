import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import type { AccountPage, EnvironmentSelection } from '@shared/auth';
import { IPC_CHANNELS } from '@shared/ipc';
import { MediaStore } from '../chat/media/MediaStore';
import { createMainLogger } from '../logger';
import { AuthService } from './AuthService';
import { ProfilePhotoCache, type PhotoRecordFile } from './profilePhoto';
import { TokenVault, type VaultFile } from './tokenVault';

/**
 * Debug logging is opt-in rather than on in dev: the shared HTTP client debug-logs request
 * bodies, and an always-on debug channel is how a credential ends up in a console transcript.
 */
const VERBOSE = process.env.B4M_DESKTOP_VERBOSE === '1';

function vaultFile(path: string): VaultFile {
  return {
    async read() {
      try {
        return await readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async write(contents) {
      await mkdir(dirname(path), { recursive: true });
      // Write-then-rename: a crash mid-write would otherwise leave a truncated vault, which
      // reads back as corrupt and silently signs the user out of every environment at once.
      const temporary = `${path}.tmp`;
      await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    },
  };
}

function photoRecordFile(path: string): PhotoRecordFile {
  return {
    async read() {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
    write(contents) {
      return writeFile(path, contents, 'utf8');
    },
    remove() {
      return rm(path, { force: true });
    },
  };
}

/**
 * Build the auth service and expose it over IPC. Call only after `app.whenReady()`:
 * `safeStorage` is not usable before the ready event.
 *
 * The registered channels carry derived state only. There is deliberately no channel that
 * returns an access token, refresh token or device code - anything needing a credential is a
 * main-process job, and a "just for convenience" getter would undo the whole arrangement.
 */
export function registerAuth(): AuthService {
  const logger = createMainLogger(VERBOSE);
  const userData = app.getPath('userData');
  const vault = new TokenVault(safeStorage, vaultFile(join(userData, 'auth-vault.json')), logger);
  // The same media directory registerChat builds its store over, and deliberately so: that is
  // the only directory the `b4m-media:` handler will serve, and the renderer's CSP admits no
  // other origin for an image. MediaStore holds no state beyond the path, so a second instance
  // over it is just a second door onto the same folder.
  const profilePhotos = new ProfilePhotoCache(
    new MediaStore(join(userData, 'media')),
    photoRecordFile(join(userData, 'profile-photo.json'))
  );

  const service = new AuthService({
    vault,
    logger,
    openExternal: url => shell.openExternal(url),
    devFallback: !app.isPackaged,
    userAgent: `b4m-desktop/${app.getVersion()}`,
    profilePhotos,
    onStateChanged: state => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC_CHANNELS.authStateChanged, state);
      }
    },
  });

  ipcMain.handle(IPC_CHANNELS.authGetState, () => service.getState());
  // Not awaited: the device flow runs until the user approves in the browser (up to the code's
  // 10-minute life), and an invoke left pending that long looks like a hung renderer. Progress
  // reaches the UI through the state-changed push instead.
  ipcMain.handle(IPC_CHANNELS.authSignIn, () => {
    void service.signIn();
  });
  ipcMain.handle(IPC_CHANNELS.authCancelSignIn, () => service.cancelSignIn());
  ipcMain.handle(IPC_CHANNELS.authSignOut, () => service.signOut());
  ipcMain.handle(IPC_CHANNELS.authRetryIdentity, () => service.retryIdentity());
  ipcMain.handle(IPC_CHANNELS.authSetEnvironment, (_event, selection: EnvironmentSelection) =>
    service.setEnvironment(selection)
  );
  ipcMain.handle(IPC_CHANNELS.authOpenAccountPage, (_event, page: AccountPage) => service.openAccountPage(page));

  return service;
}

export { AuthService } from './AuthService';
