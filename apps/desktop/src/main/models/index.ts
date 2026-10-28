import { ipcMain, powerSaveBlocker } from 'electron';
import { HuggingFaceHub, OllamaRuntime } from '@bike4mind/local-models';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ModelPull } from '@shared/models';
import type { ModelServerRegistry } from '../modelServers/ModelServerRegistry';
import { appWindows } from '../windows';
import { registerModelsIpc } from './ipc';
import { ModelHubService } from './ModelHubService';

// Room for a daemon busy finishing a pull on a loaded machine, which the library's short default reads as stopped.
const RUNTIME_HEALTH_TIMEOUT_MS = 10_000;

/**
 * The Models screen's backend. Hugging Face is only reached from here, never the renderer. The app keeps no
 * Hugging Face token, so gated and private repos cannot be verified or pulled yet.
 */
export function registerModels(servers: Pick<ModelServerRegistry, 'hubServer' | 'onServerSaved'>): ModelHubService {
  const send = (channel: string, payload?: ModelPull[] | string) => {
    for (const window of appWindows()) window.webContents.send(channel, payload);
  };
  let blocker: number | null = null;
  const service = new ModelHubService({
    // The same daemon OllamaLocal chats with, so a pulled model shows up in the picker.
    runtime: new OllamaRuntime({ healthTimeoutMs: RUNTIME_HEALTH_TIMEOUT_MS }),
    server: id => servers.hubServer(id),
    hub: new HuggingFaceHub(),
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
  return service;
}

export { ModelHubService } from './ModelHubService';
