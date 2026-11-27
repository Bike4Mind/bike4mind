import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import type { SpawnLocation } from '@shared/spawnLocation';
import type { SpawnLocationPreference } from './SpawnLocationPreference';

export interface SpawnLocationIpcDeps {
  preference: Pick<SpawnLocationPreference, 'read' | 'record'>;
  /** Tells every window the saved value, so an open Settings panel and every card agree. */
  broadcast(location: SpawnLocation): void;
}

export function registerSpawnLocationIpc(ipc: Pick<IpcMain, 'handle'>, deps: SpawnLocationIpcDeps): void {
  ipc.handle(IPC_CHANNELS.chatGetSpawnLocation, () => deps.preference.read());
  ipc.handle(IPC_CHANNELS.chatSetSpawnLocation, async (_event, location: unknown) => {
    const saved = await deps.preference.record(location);
    deps.broadcast(saved);
    return saved;
  });
}
