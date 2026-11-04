import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import { isModelSettingsId, parseModelSettingsInput } from '@shared/modelSettings';
import type { ModelSettingsStore } from './ModelSettingsStore';

export function registerModelSettingsIpc(
  ipc: Pick<IpcMain, 'handle'>,
  store: Pick<ModelSettingsStore, 'getStrict' | 'set'>
): void {
  ipc.handle(IPC_CHANNELS.chatGetModelSettings, (_event, modelId: unknown) =>
    isModelSettingsId(modelId) ? store.getStrict(modelId) : null
  );
  // Null rather than storing part of a set the renderer never meant, as for a session's overrides.
  ipc.handle(IPC_CHANNELS.chatSetModelSettings, (_event, modelId: unknown, settings: unknown) => {
    const parsed = parseModelSettingsInput(settings);
    return isModelSettingsId(modelId) && parsed ? store.set(modelId, parsed) : null;
  });
}
