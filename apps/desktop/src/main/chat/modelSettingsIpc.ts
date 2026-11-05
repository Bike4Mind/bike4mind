import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import {
  isModelSettingsId,
  isDraftTokens,
  parseModelSettingsInput,
  type ModelLoadOffer,
  type ModelSettings,
} from '@shared/modelSettings';
import type { ModelSettingsStore } from './ModelSettingsStore';

export interface ModelSettingsIpcHooks {
  /** What the model's dialog offers for its load-time options; see LocalModels.loadOffer. */
  offer?(modelId: string, draftTokens: number | undefined): Promise<ModelLoadOffer>;
  /** A model's settings were saved, so the listed models are out of date; `resized` when its sized context is too. */
  changed?(modelId: string, resized: boolean): void;
}

/** The `changed` hook for a save: forget a resized model's context, refresh the model list, tell the renderer. */
export function modelSettingsChanged(effects: {
  forgetContext(modelId: string): void;
  refreshModels(): void;
  announce(): void;
}): (modelId: string, resized: boolean) => void {
  return (modelId, resized) => {
    if (resized) effects.forgetContext(modelId);
    effects.refreshModels();
    effects.announce();
  };
}

/** Only context and draft tokens size the model; sampling, effort and keep-alive leave its loaded context alone. */
function resizes(before: ModelSettings | undefined, after: ModelSettings): boolean {
  return (
    !before ||
    before.draftTokens !== after.draftTokens ||
    JSON.stringify(before.context) !== JSON.stringify(after.context)
  );
}

export function registerModelSettingsIpc(
  ipc: Pick<IpcMain, 'handle'>,
  store: Pick<ModelSettingsStore, 'get' | 'unsupported' | 'set'>,
  hooks: ModelSettingsIpcHooks = {}
): void {
  ipc.handle(IPC_CHANNELS.chatGetModelSettings, (_event, modelId: unknown) =>
    isModelSettingsId(modelId) ? store.get(modelId) : null
  );
  ipc.handle(IPC_CHANNELS.chatGetUnsupportedModelSettings, (_event, modelId: unknown) =>
    isModelSettingsId(modelId) ? store.unsupported(modelId) : null
  );
  // Null rather than storing part of a set the renderer never meant, as for a session's overrides.
  ipc.handle(IPC_CHANNELS.chatSetModelSettings, async (_event, modelId: unknown, settings: unknown) => {
    const parsed = parseModelSettingsInput(settings);
    if (!isModelSettingsId(modelId) || !parsed) return null;
    const before = await store.get(modelId).catch(() => undefined);
    const saved = await store.set(modelId, parsed);
    hooks.changed?.(modelId, resizes(before, saved));
    return saved;
  });
  ipc.handle(IPC_CHANNELS.chatGetModelLoadOffer, async (_event, modelId: unknown, draftTokens: unknown) =>
    isModelSettingsId(modelId) && hooks.offer
      ? hooks.offer(modelId, isDraftTokens(draftTokens) ? draftTokens : undefined)
      : null
  );
}
