import { join } from 'node:path';
import { app, ipcMain, safeStorage } from 'electron';
import { HuggingFaceHub, OllamaRuntime } from '@bike4mind/local-models';
import { IPC_CHANNELS } from '@shared/ipc';
import type { HfTokenResult, ModelPull } from '@shared/models';
import { createMainLogger } from '../logger';
import { privateFile } from '../privateFile';
import { appWindows } from '../windows';
import { HuggingFaceTokenStore } from './HuggingFaceTokenStore';
import { ModelHubService } from './ModelHubService';

const MAX_TEXT = 512;
// Room for a daemon busy finishing a pull on a loaded machine, which the library's short default reads as stopped.
const RUNTIME_HEALTH_TIMEOUT_MS = 10_000;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT ? value : null;
}

const invalid = { ok: false, error: { kind: 'invalid', message: 'Invalid request.' } } as const;

/**
 * The Models screen's backend. Hugging Face is only reached from here, never the renderer, and the user's Hugging
 * Face token never leaves main except as the Authorization header of requests to huggingface.co.
 */
export function registerModels(): ModelHubService {
  const send = (channel: string, payload?: ModelPull[]) => {
    for (const window of appWindows()) window.webContents.send(channel, payload);
  };
  const logger = createMainLogger(process.env.B4M_DESKTOP_VERBOSE === '1');
  const tokens = new HuggingFaceTokenStore(
    safeStorage,
    privateFile(join(app.getPath('userData'), 'hugging-face-token.json')),
    logger
  );
  const service = new ModelHubService({
    // The same daemon OllamaLocal chats with, so a pulled model shows up in the picker.
    runtime: new OllamaRuntime({ healthTimeoutMs: RUNTIME_HEALTH_TIMEOUT_MS }),
    // Default endpoint only: a token must never follow a configurable host.
    createHub: token => new HuggingFaceHub(token ? { token } : {}),
    tokens,
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
    const revision = text(body?.revision);
    const sizeBytes = body?.sizeBytes;
    if (!repo || !buildId || !revision || typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes))
      return { ...invalid, listed: false };
    return service.pull({
      repo,
      buildId,
      revision,
      sizeBytes,
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
  ipcMain.handle(IPC_CHANNELS.modelsGetHfAccess, () => service.tokenStatus());
  const publishTokenResult = (result: HfTokenResult, senderId: number): HfTokenResult => {
    if (result.ok) {
      for (const window of appWindows()) {
        if (window.webContents.id !== senderId)
          window.webContents.send(IPC_CHANNELS.modelsHfAccessChanged, result.status);
      }
    }
    return result;
  };
  ipcMain.handle(IPC_CHANNELS.modelsSaveHfAccess, async (event, token: unknown) => {
    const value = text(token);
    return value ? publishTokenResult(await service.setToken(value), event.sender.id) : invalid;
  });
  ipcMain.handle(IPC_CHANNELS.modelsClearHfAccess, async event =>
    publishTokenResult(await service.clearToken(), event.sender.id)
  );

  return service;
}

export { ModelHubService } from './ModelHubService';
