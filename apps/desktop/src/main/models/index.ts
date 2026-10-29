import { join } from 'node:path';
import { app, ipcMain, powerSaveBlocker, safeStorage } from 'electron';
import { HuggingFaceHub, OllamaRuntime } from '@bike4mind/local-models';
import { IPC_CHANNELS } from '@shared/ipc';
import type { HfTokenResult, ModelPull } from '@shared/models';
import { createMainLogger } from '../logger';
import type { ModelServerRegistry } from '../modelServers/ModelServerRegistry';
import { privateFile } from '../privateFile';
import { appWindows } from '../windows';
import { HuggingFaceTokenStore } from './HuggingFaceTokenStore';
import { invalid, registerModelsIpc, text } from './ipc';
import { ModelHubService } from './ModelHubService';

// Room for a daemon busy finishing a pull on a loaded machine, which the library's short default reads as stopped.
const RUNTIME_HEALTH_TIMEOUT_MS = 10_000;

/**
 * The Models screen's backend. Hugging Face is only reached from here, never the renderer, and the user's Hugging
 * Face token never leaves main except as the Authorization header of requests to huggingface.co.
 */
export function registerModels(servers: Pick<ModelServerRegistry, 'hubServer' | 'onServerSaved'>): ModelHubService {
  const send = (channel: string, payload?: ModelPull[] | string) => {
    for (const window of appWindows()) window.webContents.send(channel, payload);
  };
  const logger = createMainLogger(process.env.B4M_DESKTOP_VERBOSE === '1');
  const tokens = new HuggingFaceTokenStore(
    safeStorage,
    privateFile(join(app.getPath('userData'), 'hugging-face-token.json')),
    logger
  );
  let blocker: number | null = null;
  const service = new ModelHubService({
    // The same daemon OllamaLocal chats with, so a pulled model shows up in the picker.
    runtime: new OllamaRuntime({ healthTimeoutMs: RUNTIME_HEALTH_TIMEOUT_MS }),
    server: id => servers.hubServer(id),
    // Default endpoint only: a token must never follow a configurable host.
    createHub: token => new HuggingFaceHub(token ? { token } : {}),
    tokens,
    onPullsChanged: pulls => send(IPC_CHANNELS.modelsPullsChanged, pulls),
    // Once, right away: the picker's reload waits for any recheck the pull or removal started.
    onInstalledChanged: serverId => send(IPC_CHANNELS.modelsInstalledChanged, serverId),
    keepAwake: on => {
      if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
      if (!on && blocker !== null) {
        powerSaveBlocker.stop(blocker);
        blocker = null;
      }
    },
  });
  servers.onServerSaved(id => service.serverChanged(id));
  registerModelsIpc(ipcMain, service);

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
