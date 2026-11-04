import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import { isModelSettingsId, isDraftTokens, parseModelSettingsInput, type ModelLoadOffer } from '@shared/modelSettings';
import type { ModelSettingsStore } from './ModelSettingsStore';

export interface ModelSettingsIpcHooks {
  /** What the model's dialog offers for its load-time options; see LocalModels.loadOffer. */
  offer?(modelId: string, draftTokens: number | undefined): Promise<ModelLoadOffer>;
  /** A model's settings were saved, so its sized context and the listed models are out of date. */
  changed?(modelId: string): void;
}

/** The `changed` hook for a save: forget the model's sized context, refresh the model list, tell the renderer. */
export function modelSettingsChanged(effects: {
  forgetContext(modelId: string): void;
  refreshModels(): void;
  announce(): void;
}): (modelId: string) => void {
  return modelId => {
    effects.forgetContext(modelId);
    effects.refreshModels();
    effects.announce();
  };
}

export function registerModelSettingsIpc(
  ipc: Pick<IpcMain, 'handle'>,
  store: Pick<ModelSettingsStore, 'getStrict' | 'set'>,
  hooks: ModelSettingsIpcHooks = {}
): void {
  ipc.handle(IPC_CHANNELS.chatGetModelSettings, (_event, modelId: unknown) =>
    isModelSettingsId(modelId) ? store.getStrict(modelId) : null
  );
  // Null rather than storing part of a set the renderer never meant, as for a session's overrides.
  ipc.handle(IPC_CHANNELS.chatSetModelSettings, async (_event, modelId: unknown, settings: unknown) => {
    const parsed = parseModelSettingsInput(settings);
    if (!isModelSettingsId(modelId) || !parsed) return null;
    const saved = await store.set(modelId, parsed);
    hooks.changed?.(modelId);
    return saved;
  });
  ipc.handle(IPC_CHANNELS.chatGetModelLoadOffer, async (_event, modelId: unknown, draftTokens: unknown) =>
    isModelSettingsId(modelId) && hooks.offer
      ? hooks.offer(modelId, isDraftTokens(draftTokens) ? draftTokens : undefined)
      : null
  );
}
