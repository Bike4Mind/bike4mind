import { ipcMain } from 'electron';
import { HuggingFaceHub, OllamaRuntime } from '@bike4mind/local-models';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ModelPull } from '@shared/models';
import { appWindows } from '../windows';
import { ModelHubService } from './ModelHubService';

const MAX_TEXT = 512;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT ? value : null;
}

const invalid = { ok: false, error: { kind: 'invalid', message: 'Invalid request.' } } as const;

/**
 * The Models screen's backend. Hugging Face is only reached from here, never the renderer. The app keeps no
 * Hugging Face token, so gated and private repos cannot be verified or pulled yet.
 */
export function registerModels(): ModelHubService {
  const send = (channel: string, payload?: ModelPull[]) => {
    for (const window of appWindows()) window.webContents.send(channel, payload);
  };
  const service = new ModelHubService({
    // The same daemon OllamaLocal chats with, so a pulled model shows up in the picker.
    runtime: new OllamaRuntime(),
    hub: new HuggingFaceHub(),
    onPullsChanged: pulls => send(IPC_CHANNELS.modelsPullsChanged, pulls),
    onInstalledChanged: () => send(IPC_CHANNELS.modelsInstalledChanged),
  });

  ipcMain.handle(IPC_CHANNELS.modelsGetStatus, () => service.status());
  ipcMain.handle(IPC_CHANNELS.modelsListInstalled, () => service.installed());
  ipcMain.handle(IPC_CHANNELS.modelsListPulls, () => service.pulls());
  ipcMain.handle(IPC_CHANNELS.modelsSearch, (_event, request: unknown) => {
    const body = request && typeof request === 'object' ? (request as Record<string, unknown>) : null;
    const query = typeof body?.query === 'string' ? body.query.slice(0, MAX_TEXT) : null;
    if (query === null) return invalid;
    return service.search({ query, cursor: text(body?.cursor) });
  });
  ipcMain.handle(IPC_CHANNELS.modelsGetDetail, (_event, repo: unknown) => {
    const id = text(repo);
    return id ? service.detail(id) : invalid;
  });
  ipcMain.handle(IPC_CHANNELS.modelsPull, (_event, request: unknown) => {
    const body = request && typeof request === 'object' ? (request as Record<string, unknown>) : null;
    const repo = text(body?.repo);
    const buildId = text(body?.buildId);
    if (!repo || !buildId) return invalid;
    return service.pull({
      repo,
      buildId,
      acceptLicense: body?.acceptLicense === true,
      confirmAccess: body?.confirmAccess === true,
    });
  });
  ipcMain.handle(IPC_CHANNELS.modelsCancelPull, (_event, key: unknown) => {
    const id = text(key);
    if (id) service.cancel(id);
  });
  ipcMain.handle(IPC_CHANNELS.modelsDismissPull, (_event, key: unknown) => {
    const id = text(key);
    if (id) service.dismiss(id);
  });
  ipcMain.handle(IPC_CHANNELS.modelsRemove, (_event, name: unknown) => {
    const id = text(name);
    return id ? service.remove(id) : invalid;
  });

  return service;
}

export { ModelHubService } from './ModelHubService';
