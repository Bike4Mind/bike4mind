import { app, safeStorage } from 'electron';
import { createAppSecretCipher, type AppSecretCipher } from './appSecretCipher';
import { runProcess } from './runProcess';

let shared: AppSecretCipher | undefined;

/** The one cipher every secret store uses. Call after the app `ready` event, as with safeStorage. */
export function appSecretCipher(): AppSecretCipher {
  shared ??= createAppSecretCipher({
    platform: process.platform,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    mockKeychain: app.commandLine.hasSwitch('use-mock-keychain'),
    appName: app.getName(),
    safeStorage,
    run: runProcess,
    warn: message => console.warn(message),
  });
  return shared;
}
