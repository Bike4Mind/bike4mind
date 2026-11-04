import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import {
  isModelSettingsId,
  MAX_DRAFT_TOKENS,
  parseModelSettingsInput,
  type ModelLoadOffer,
} from '@shared/modelSettings';
import type { ModelSettingsStore } from './ModelSettingsStore';

export interface ModelSettingsIpcHooks {
  /** What the model's dialog offers for its load-time options; see LocalModels.loadOffer. */
  offer?(modelId: string, draftTokens: number | undefined): Promise<ModelLoadOffer>;
  /** A model's settings were saved, so its sized context and the listed models are out of date. */
  changed?(modelId: string): void;
}

function draftArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_DRAFT_TOKENS
    ? value
    : undefined;
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
    isModelSettingsId(modelId) && hooks.offer ? hooks.offer(modelId, draftArg(draftTokens)) : null
  );
}
