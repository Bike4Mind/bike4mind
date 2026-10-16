import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { app, ipcMain } from 'electron';
import type { ChatStreamEvent } from '@shared/chat';
import type { FleetState } from '@shared/fleet';
import { IPC_CHANNELS } from '@shared/ipc';
import type { VaultFile } from '../auth/tokenVault';
import { createMainLogger } from '../logger';
import { appWindows } from '../windows';
import { ActivityQueue } from './ActivityQueue';
import { ActivityRecorder } from './ActivityRecorder';
import { FleetClient } from './FleetClient';
import { readFleetConfig } from './FleetConfig';
import { FleetService } from './FleetService';
import { FleetSettingsStore } from './FleetSettingsStore';
import { createRepositoryResolver } from './repository';

/** How often the installer file is read again, so a rerun of the installer is picked up. */
const CONFIG_REFRESH_MS = 5 * 60_000;

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

/** Fleet's installer writes this; see FleetConfig. A dev build may point elsewhere for testing. */
function configPath(): string {
  const override = process.env.B4M_FLEET_CONFIG;
  if (!app.isPackaged && override) return override;
  return join(homedir(), '.claude', 'fleet', 'bike4mind-desktop.json');
}

function tilde(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export interface RegisteredFleet {
  service: FleetService;
  /** Feed every chat stream event here; it is a no-op while sharing is off. */
  observe(event: ChatStreamEvent): void;
  /** Late-bound because chat is built after this; resolves a conversation's working directory. */
  setDirectoryResolver(resolve: (sessionId: string) => Promise<string | null>): void;
  dispose(): void;
}

/** Build the Fleet integration and expose it over IPC. Call after `whenReady`. */
export function registerFleet(): RegisteredFleet {
  const logger = createMainLogger(process.env.B4M_DESKTOP_VERBOSE === '1');
  const userData = app.getPath('userData');
  const path = configPath();
  const send = (state: FleetState) => {
    for (const window of appWindows()) window.webContents.send(IPC_CHANNELS.fleetStateChanged, state);
  };

  const service = new FleetService({
    settings: new FleetSettingsStore(userDataFile(join(userData, 'fleet-integration.json')), logger),
    queue: new ActivityQueue(userDataFile(join(userData, 'fleet-activity-queue.json'))),
    client: new FleetClient(),
    readConfig: () => readFleetConfig(path),
    configPath: tilde(path),
    appVersion: app.getVersion(),
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
  ipcMain.handle(IPC_CHANNELS.fleetRefresh, () => service.refresh());
  ipcMain.handle(IPC_CHANNELS.fleetSetConsent, (_event, consent: unknown) => service.setConsent(consent === true));
  ipcMain.handle(IPC_CHANNELS.fleetSendNow, () => service.sendNow());

  void service.initialize();
  const refresher = setInterval(() => void service.refresh(), CONFIG_REFRESH_MS);
  refresher.unref?.();

  return {
    service,
    observe: event => recorder.observe(event),
    setDirectoryResolver: resolve => {
      directoryFor = resolve;
    },
    dispose: () => {
      clearInterval(refresher);
      service.dispose();
    },
  };
}
