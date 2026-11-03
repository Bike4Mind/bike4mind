import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import type { LocalContextFit } from '@shared/localContextSetting';
import type { LocalContextPreference } from './LocalContextPreference';

export interface LocalContextIpcDeps {
  preference: Pick<LocalContextPreference, 'read' | 'record'>;
  /** Drops every settled context and the catalog's cached local list, so each model is sized again. */
  forget(): void;
  fit(): Promise<LocalContextFit>;
}

export function registerLocalContextIpc(ipc: Pick<IpcMain, 'handle'>, deps: LocalContextIpcDeps): void {
  ipc.handle(IPC_CHANNELS.chatGetLocalContext, () => deps.preference.read());
  ipc.handle(IPC_CHANNELS.chatSetLocalContext, async (_event, setting: unknown) => {
    const saved = await deps.preference.record(setting);
    deps.forget();
    return saved;
  });
  ipc.handle(IPC_CHANNELS.chatGetLocalContextFit, () => deps.fit());
}
