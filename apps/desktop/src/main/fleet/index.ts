import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app, ipcMain, safeStorage } from 'electron';
import type { ChatStreamEvent } from '@shared/chat';
import type { FleetSettingsInput, FleetState } from '@shared/fleet';
import { IPC_CHANNELS } from '@shared/ipc';
import type { VaultFile } from '../auth/tokenVault';
import { createMainLogger } from '../logger';
import { appWindows } from '../windows';
import { ActivityQueue } from './ActivityQueue';
import { ActivityRecorder } from './ActivityRecorder';
import { FleetClient } from './FleetClient';
import { FleetService } from './FleetService';
import { FleetSettingsStore } from './FleetSettingsStore';
import { createRepositoryResolver } from './repository';

const PRODUCTION_FLEET_URL = 'https://fleet.bike4mind.com';
const STAGING_FLEET_URL = 'https://staging.fleet.bike4mind.com';

/** Mode 0600 and write-then-rename, like the auth vault, so a crash cannot truncate it. */
function userDataFile(path: string): VaultFile {
  return {
    read: () => readFile(path, 'utf8').catch(() => null),
    write: async contents => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    },
  };
}

export interface RegisteredFleet {
  service: FleetService;
  /** Feed every chat stream event here; it is a no-op while sharing is off. */
  observe(event: ChatStreamEvent): void;
  /** Late-bound because chat is built after this; resolves a conversation's working directory. */
  setDirectoryResolver(resolve: (sessionId: string) => Promise<string | null>): void;
}

/**
 * Build the Fleet integration and expose it over IPC. Call after `whenReady`: the key store
 * asks safeStorage whether encryption is available on first use.
 */
export function registerFleet(): RegisteredFleet {
  const logger = createMainLogger(process.env.B4M_DESKTOP_VERBOSE === '1');
  const userData = app.getPath('userData');
  const send = (state: FleetState) => {
    for (const window of appWindows()) window.webContents.send(IPC_CHANNELS.fleetStateChanged, state);
  };

  const service = new FleetService({
    settings: new FleetSettingsStore(safeStorage, userDataFile(join(userData, 'fleet-integration.json')), logger),
    queue: new ActivityQueue(userDataFile(join(userData, 'fleet-activity-queue.json'))),
    client: new FleetClient(),
    // A dev run points at staging so local testing never touches production data.
    defaultUrl: app.isPackaged ? PRODUCTION_FLEET_URL : STAGING_FLEET_URL,
    logger,
    onState: send,
  });

  let directoryFor: (sessionId: string) => Promise<string | null> = async () => null;
  const repositoryAt = createRepositoryResolver();
  const recorder = new ActivityRecorder({
    enabled: () => service.recording(),
    record: events => void service.record(events),
    repositoryFor: async sessionId => {
      const directory = await directoryFor(sessionId);
      return directory ? repositoryAt(directory) : null;
    },
  });

  ipcMain.handle(IPC_CHANNELS.fleetGetState, () => service.getState());
  ipcMain.handle(IPC_CHANNELS.fleetSave, (_event, input: FleetSettingsInput) => service.save(input));
  ipcMain.handle(IPC_CHANNELS.fleetForgetKey, () => service.forgetKey());
  ipcMain.handle(IPC_CHANNELS.fleetSetConsent, (_event, consent: unknown) => service.setConsent(consent === true));
  ipcMain.handle(IPC_CHANNELS.fleetTestConnection, () => service.testConnection());
  ipcMain.handle(IPC_CHANNELS.fleetSendNow, () => service.sendNow());

  void service.initialize();

  return {
    service,
    observe: event => recorder.observe(event),
    setDirectoryResolver: resolve => {
      directoryFor = resolve;
    },
  };
}
